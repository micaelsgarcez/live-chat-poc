# Sub-salas automáticas

> Estado: **implementado** em `3ad0519`. Este documento tem três
> partes, e elas não devem ser confundidas: o que foi **pesquisado** (§1–§2),
> o que foi **decidido** e por quê (§3, no formato de grill: pergunta →
> resposta adotada), e o que deve ser **construído** (§4, o plano que o
> executor segue à risca).

## 0. O problema em uma frase

A POC mediu (`docs/LOADTEST.md` §3.4) que o teto da arquitetura não é socket,
CPU nem taxa de entrada: é o `RoomCoordinator` **esperar todos os shards** a
cada mensagem. Mais shards pioram a latência (8 → 20 shards: ack p99 601 →
922 ms). Enquanto toda mensagem precisar chegar a todo mundo, nenhuma fila,
árvore ou janela tira essa espera do caminho quente — só a adia.

Chat de live de verdade não entrega tudo para todo mundo. A sub-sala é a
forma honesta de dizer isso: **a sala é dividida automaticamente pelo volume
de gente, e uma mensagem comum só chega a quem está na mesma sub-sala.** O
que é da sala inteira — a palavra do streamer e dos moderadores, apagar,
banir, configuração, presença total — continua chegando a todos.

## 1. Como as grandes plataformas fazem

| plataforma | o que faz com um chat gigante | fonte |
|---|---|---|
| **Twitch** | Não divide a audiência. Entrega tudo a todos com *fanout hierárquico* (Edge ↔ Pubsub, em Go, >10 bilhões de mensagens/dia). O que salva a leitura é o cliente: buffer curto, slow-mode, followers-only. | [Twitch Engineering: An Introduction and Overview](https://blog.twitch.tv/en/2015/12/18/twitch-engineering-an-introduction-and-overview-a23917b71a25/) |
| **YouTube** | Duas visões: *Top chat*, filtrada por sinais (spam, impersonação, "conteúdo que o espectador provavelmente não valoriza"), e *Live chat*, sem filtro. A documentação pública **não** descreve amostragem por volume; o que ela descreve é filtro por relevância. | [Learn about Live Chat](https://support.google.com/youtube/answer/15268877?hl=en) |
| **LINE LIVE** | **Divide os espectadores em salas de chat**: "users can only chat with other users that are in the same chat room". 10 mil comentários/minuto numa única live, mais de 100 instâncias de servidor, Redis Cluster Pub/Sub entre servidores. É o desenho mais próximo do que este documento propõe. | [The architecture behind chatting on LINE LIVE](https://engineering.linecorp.com/en/blog/the-architecture-behind-chatting-on-line-live/) |
| **RumbleTalk** (produto de chat para lives) | Múltiplas salas por *auto-seleção* (página principal, Q&A, membros). Recomenda poucas salas, moderador por sala e identidade consistente entre elas. | [Scaling Live Stream Chats With Multiple Chat Rooms](https://rumbletalk.com/blog/index.php/2026/01/26/live-stream-chats/) |

Duas lições saem daí. A primeira: dividir a audiência é uma técnica
estabelecida (LINE LIVE), não uma gambiarra. A segunda: quem divide **não
divide o que é do host** — a mensagem do criador, a moderação e a identidade
do usuário são da sala inteira, sempre.

## 2. O que a Cloudflare limita — e por que isso decide o desenho

| limite | valor | consequência |
|---|---|---|
| Taxa de requisições **por Durable Object** | soft limit de **1.000 req/s** | 30 mil remetentes a 1 msg/30 s são 1.000 `publish`/s **num único coordinator**: o desenho atual encosta no limite documentado antes de qualquer otimização. Em sub-salas, o coordinator recebe só o que é da sala inteira. |
| Subrequests por invocação | 10.000 no plano pago (era 1.000) | Deixa de ser o motivo para o fanout em lotes de 32; continua valendo como boa prática. |
| Conexões de saída simultâneas por DO | 6 | O `callInBatches` de 32 já está acima; o runtime enfileira. Não muda com este plano. |
| WebSockets por DO | não documentado na página de limites | O teto continua sendo o que o shard aguenta **escrever** por segundo, e esse número a POC não tem (`README.md`, "O que faltaria construir", item 4). A sub-sala transforma isso na única medida que importa. |

Fontes: [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Subrequests limit changelog](https://developers.cloudflare.com/changelog/2026-02-11-subrequests-limit).

## 3. Grill — as complicações e o que foi decidido

Cada pergunta abaixo é um galho da árvore de decisão. A seta é a resposta
**adotada**; o plano da §4 implementa exatamente isso. Uma resposta que
depende de outra aparece numa rodada posterior.

### Rodada 1 — o que é uma sub-sala

❓ **Q1 — O que é uma sub-sala, no código?**
Três opções: (a) um objeto novo, com grupos de shards por baixo; (b) um
grupo de K shards com um mini-coordinator próprio; (c) **um `ChatShard` é
uma sub-sala**.

➡️ **(c).** O shard já é uma partição de conexões com pipeline, estado de
gate, buffer de persistência e fanout local. Fazer dele a sub-sala custa zero
objetos novos e tira o coordinator do caminho quente por construção: uma
mensagem comum nasce no shard, é confirmada no shard e entregue no shard. (b)
reintroduz o `await` que a medição condenou, só que menor. (a) é (b) com mais
nomes.

---

❓ **Q2 — É um modo da sala ou uma mudança de arquitetura?**

➡️ **Um modo, em runtime, desligado por padrão:** `fanout.scope: "room" |
"subroom"`. Mesma disciplina das outras alavancas (`batchWindowMs`,
`maxPerViewerPerSecond`): a sala se comporta exatamente como antes até alguém
ligar, o `PATCH /config` liga sem deploy, e o teste de carga é o que diz a
partir de qual degrau ligar. Salas que já existem leem `scope: "room"` via
`normalizeRoomConfig`.

---

❓ **Q3 — O que atravessa as sub-salas?**
A complicação central: se nada atravessa, o streamer fala para 1/60 da
audiência e um moderador não modera. Se tudo atravessa, não há sub-sala.

➡️ **Atravessa o que é da sala; fica o que é da conversa.**

| da sala inteira (passa pelo coordinator, como hoje) | da sub-sala (local ao shard) |
|---|---|
| mensagens de `privilegedRoles` (streamer, moderador, sistema) | mensagens de todo mundo mais |
| `delete` (retroativo, de moderador ou da fila assíncrona) | reações |
| ban / kick / mute | respostas (`replyTo`) — só cita o que a sub-sala viu |
| `config` | menções `@` — só alcançam quem está na mesma sub-sala |
| `presence` (total da sala) | presença da sub-sala (contagem local) |

A mensagem privilegiada usa o caminho de `publish` que já existe. É rara, e o
coordinator esperando 60 shards por **uma mensagem a cada tantos segundos** é
exatamente o custo que a medição mostrou ser aceitável.

---

❓ **Q4 — Como o volume divide as pessoas?**
"Dividido automaticamente pelo volume" tem duas leituras: (a) *fill-first*
(a sub-sala 0 enche até o alvo, depois abre a 1…), que dá salas sempre vivas
mas exige contagem de ocupação fresca na borda e quebra a aderência do usuário
ao seu shard; (b) **hash por usuário dentro do conjunto de sub-salas abertas,
e o conjunto cresce com a presença** — o que o código já faz com
`planShardCount`.

➡️ **(b), começando de 1.** Com 100 pessoas há uma sub-sala de 100; ao passar
de 70 % de `maxSocketsPerShard`, o coordinator dobra o número no próximo
alarm, e só *quem chega depois* cai nas novas. Ninguém é movido no meio da
conversa, o reconectar continua caindo no mesmo shard (estado de token bucket,
slow-mode e mute quentes), e a borda continua sem round-trip de DO por
conexão. O preço é a sub-sala recém-aberta começar vazia e encher em
segundos — aceitável numa live que está crescendo, e a Q8 cobre o pico.

### Rodada 2 — tamanho, crescimento, aderência

❓ **Q5 — Qual é o tamanho de uma sub-sala?**

➡️ **`maxSocketsPerShard`, que passa a ser editável no `PATCH /config`.**
Um botão só: o teto de sockets do shard *é* o tamanho da sub-sala, e o
crescimento em 70 % dele já existe. O default continua 5.000; a recomendação
operacional é começar em **2.000** até o teto de escrita de um shard ser
medido (§5). Não há um segundo campo "subRoomSize" para desalinhar do primeiro.

---

❓ **Q6 — E quando a live esvazia? Sub-salas ficam ralas.**
Uma live que picou em 300 mil (60 sub-salas) e caiu para 3 mil tem 50 pessoas
por sub-sala.

➡️ **Não encolhe nem funde na v1.** Encolher remapeia quem reconecta para um
shard sem o seu estado, e fundir sub-salas ao vivo é mover sockets — exatamente
o que a Q4 evitou. 50 pessoas por sub-sala ainda é um chat. O `getStats` passa
a expor a ocupação média por sub-sala para o operador ver, e a fusão fica
documentada como trabalho seguinte.

---

❓ **Q7 — O usuário pode escolher a sub-sala? E um amigo meu?**
Complicação social: duas pessoas que assistem juntas caem em sub-salas
diferentes e não se veem. Complicação de abuso: se qualquer um escolhe a
sub-sala, um mutado troca de sala para escapar do mute.

➡️ **Usuário comum não escolhe; papel privilegiado escolhe.** A colocação
determinística é o que dá aderência e o que impede o mute de ser contornado.
Moderador e streamer podem conectar com `?sub=N` para ver qualquer sub-sala
(é assim que se modera: como no RumbleTalk, "moderador por sala"). Amigos
juntos na mesma sub-sala é uma feature de produto que **não** está neste
plano; fica registrada.

---

❓ **Q8 — O shard está cheio e a borda não sabe (KV cacheado por 60 s). O que
acontece com quem chega no pico?**
Hoje o shard responde 503 e a borda repassa o 503: a pessoa fica de fora.

➡️ **A borda sonda.** Ao receber `503 shard full`, tenta os próximos índices
`(h+1) % n`, `(h+2) % n` (no máximo 3 sondas) e, se todos estiverem cheios,
tenta o índice `n` — abre a próxima sub-sala. O shard novo se registra no
coordinator, e **um registro com índice ≥ `shardCount` faz o coordinator
adotar `shardCount = índice + 1`** e publicar no KV. O pico abre sala sozinho,
sem esperar o alarm de 15 s. A aderência é perdida só para quem foi sondado, e
só quando a sala estava cheia.

---

❓ **Q9 — A coalescência e a amostragem continuam valendo dentro da sub-sala?**
A medição diz que a janela é a alavanca mais barata e que o laço de fanout
por socket é o custo real.

➡️ **Sim, as duas, dentro do shard.** O shard aplica `batchWindowMs`
localmente com a mesma regra do coordinator: **ack antes de esperar a
janela**, uma flush por janela, um frame por socket com a janela inteira. A
amostragem por espectador já é local. Novidade: **mensagem de papel
privilegiado nunca é amostrada** — ganha o primeiro lugar no ranking do
`DeliveryPlan`.

---

❓ **Q10 — Duas fontes de eventos (local e coordinator) chegam ao mesmo socket.
E a ordem?**

➡️ **Ordem por socket, não ordem global.** O que o shard entrega a um socket
sai na ordem em que o shard viu. A regra que já existe no coordinator — um
`delete`/`config`/`presence` nunca ultrapassa o que está na janela pendente —
vale igual no shard: ao receber um `fanout` do coordinator, o shard descarrega
o que tinha pendente antes, no mesmo frame. Não há relógio global entre
sub-salas, e não precisa haver: elas não compartilham conversa.

### Rodada 3 — protocolo, presença, histórico, moderação

❓ **Q11 — O que muda no wire?**

➡️ **Aditivo, e o mínimo:**
- `PublicRoomConfig.scope` — o cliente precisa saber que está numa sub-sala
  para dizer isso na tela.
- `ServerPresence.sub?: number` — quantos estão *nesta* sub-sala, ao lado do
  total. O shard preenche ao repassar o `presence` do coordinator.
- `ChatMessage.roomWide?: true` — marca a mensagem que atravessou (privilegiada);
  o cliente destaca "para todos".
- `ServerHello.shardIndex` já existe e passa a ser o número da sub-sala.

---

❓ **Q12 — Presença: mostrar o total da sala ou da sub-sala?**

➡️ **Os dois; o total em destaque.** É o que Twitch e YouTube mostram
("12.340 assistindo"), e é o critério que o teste de carga confere. A
sub-sala aparece discreta ("sala 3 · 1.240 aqui").

---

❓ **Q13 — Histórico e reidratação de respostas.**
O shard reidrata a janela de `replyTo` do histórico da sala inteira; em
sub-sala isso citaria mensagens que o remetente nunca viu. E a página de
histórico mostra tudo misturado.

➡️ **Filtrar por sub-sala; a coluna já existe.** `messages.shard_index` é
gravada por lote desde a primeira migration. `listRoomMessages` ganha um filtro
opcional de `shardIndex`; em `scope: "subroom"` o shard reidrata só a própria
sub-sala e a rota de histórico aceita `?sub=N`. Uma migration nova acrescenta
o índice `(room_id, shard_index, ts DESC)`. Sem filtro, o histórico continua
sendo o da sala inteira — é o que um moderador quer.

---

❓ **Q14 — Moderação: quem vê o que está acontecendo em 60 sub-salas?**

➡️ **O que já vê tudo continua vendo tudo.** A fila assíncrona recebe toda
mensagem aceita, de toda sub-sala, e o `delete` que ela emite atravessa. O
console de observabilidade já é um fan-in por shard — cada linha vira uma
sub-sala. O moderador humano entra na sub-sala que quiser com `?sub=N` (Q7).
Ban é na borda (KV), então um banido não entra em sub-sala nenhuma, sondado ou
não. **Um mute é por shard**: quem foi sondado para outra sub-sala (Q8) perde
o mute — o mute é penalidade branda, o ban é a dura, e é assim que já era
entre reconexões após expirar o estado.

---

❓ **Q15 — Contadores do coordinator ficam errados: `messagesPublished` só vê
o que atravessa.**

➡️ **Aceitar e documentar.** `RoomStats.messagesPublished` passa a significar
"mensagens que passaram pelo coordinator". O total aceito por sub-sala já sai
do fan-in de observabilidade (`acceptedCount` por shard), que é onde o
operador olha. Mudar `reportPresence` para carregar contadores é tocar num
port congelado por um número que já existe em outro lugar.

### Rodada 4 — ferramentas, cliente, testes

❓ **Q16 — O gerador de carga confere "mensagem confirmada e não entregue"
como *o remetente recebeu a própria mensagem*. Isso continua valendo?**

➡️ **Vale, sem mudança no critério.** O remetente sempre recebe a própria
mensagem (`alwaysDeliverOwn`), local ou não. O gerador passa a: (1) registrar
a sub-sala de cada cliente pelo `hello`; (2) reportar a distribuição
(sub-salas abertas, maior/menor ocupação); (3) aceitar `--scope subroom` no
anúncio da sala; (4) nos presets `medium` e acima, ligar `scope: "subroom"`
com `shardCount: 1` e `maxSocketsPerShard` do preset, para que a escada meça
o crescimento automático. O modelo de custo (`cost.mjs`) passa a cobrar
chamada de DO só do que atravessa.

---

❓ **Q17 — O que o cliente de demonstração mostra?**

➡️ Três coisas, e nada de UI nova: o rótulo da sub-sala ao lado da presença
(Q12), o selo "para todos" numa mensagem `roomWide` (Q11), e, para quem tem
papel privilegiado, um seletor de sub-sala que reconecta com `?sub=N` (Q7). O
"mostrando X de Y msg/s" já existe.

---

❓ **Q18 — Testes: o que precisa estar preso?**

➡️ Unitários ao lado do código e um teste de integração que cruza fatias:
- `routing`: sequência de sondagem `(h, h+1, h+2, n)` é pura e determinística;
  `?sub=` só é honrado com papel privilegiado.
- `coordinator`: em `subroom`, `publish` de mensagem comum **não** é chamado;
  de privilegiada atravessa; `registerShard(index ≥ shardCount)` adota o
  índice e publica o KV.
- `shard`: entrega local com janela (ack antes da flush), presença enriquecida
  com `sub`, privilegiada nunca amostrada, pendente local descarregado antes
  de um `fanout` externo.
- `tests/subrooms.test.ts`: dois usuários em sub-salas diferentes não se veem;
  a mensagem do moderador chega aos dois; `delete` e ban chegam aos dois; o
  histórico com `?sub=` filtra; com `maxSocketsPerShard: 1` o terceiro
  usuário abre a sub-sala 2 e o `shardCount` cresce.

---

❓ **Q19 — Quem pode tocar nos contratos congelados?**

➡️ **Este plano é a autorização do integrador.** O `CLAUDE.md` congela
`src/shared/**`, `migrations/**` e afins para que fatias paralelas não se
pisem; aqui não há paralelismo — é uma mudança transversal executada por um
agente só. A §4.1 lista **exatamente** quais arquivos congelados mudam e o
quê. Fora da lista, a regra do `CLAUDE.md` continua valendo.

Frontier vazia: nenhum galho ficou sem decisão.

## 4. Plano de implementação

Ordem obrigatória — cada passo deixa `npm run check` verde antes do próximo.
Commits pequenos, um por passo, mensagem em português no imperativo (como o
histórico do repo).

### 4.1 Contratos (`src/shared/**`, migrations) — só isto muda neles

| arquivo | mudança |
|---|---|
| `src/shared/room-config.ts` | `FanoutConfig.scope: "room" \| "subroom"` (default `"room"`, com comentário do porquê). `RoomConfigPatch` ganha `"maxSocketsPerShard"`. `normalizeRoomConfig`/`mergeRoomConfig` já espalham `fanout`; conferir que `scope` cai no default. `toPublicConfig` expõe `scope`. |
| `src/shared/protocol.ts` | `PublicRoomConfig.scope`; `ServerPresence.sub?: number`; `ChatMessage.roomWide?: true`. Nada removido. |
| `src/shared/ports.ts` | `RoomStats` ganha `averageSubRoomOccupancy: number` (conexões ÷ shards registrados). Nenhuma assinatura de método muda. |
| `migrations/0003_subroom_history_index.sql` | `CREATE INDEX IF NOT EXISTS idx_messages_room_shard_ts ON messages (room_id, shard_index, ts DESC);` |

### 4.2 Borda — `src/features/routing/`, `src/features/connect/`

- `routing/index.ts`: `placementCandidates(placementKey, shardCount, maxProbes = 3): number[]`
  → `[h, (h+1)%n, (h+2)%n, n]` sem repetidos (com `n = 1` é `[0, 1]`).
  Teste unitário em `routing/placement.test.ts`.
- `connect/index.ts`: depois do rate-limit, lê `?sub=N`; honra **só** se
  `hasRole(identity, defaultRoomConfig(roomId).privilegedRoles)`. A borda
  não faz round-trip de DO por conexão, então usa a lista padrão de papéis,
  não a da sala — documentar isso no comentário: um papel privilegiado
  adicionado só via `PATCH` não ganha `?sub=` (e não precisa: moderador,
  admin e system já estão no padrão).
- Ao receber `503` do shard, tenta o próximo candidato; esgotados, devolve o
  último `503`. Cada tentativa é um `new Request(req.url, req)` novo.
- O `hello` já carrega `shardIndex`; nada a fazer no shard por isso.

### 4.3 Coordinator — `src/realtime/coordinator.ts`, `coordinator/`

- `registerShard(roomId, index)`: se `index >= config.shardCount`,
  `applyConfigChange(mergeRoomConfig(config, { shardCount: index + 1 }), config.shardCount)`
  (limitado por `MAX_SHARD_COUNT`). Log em `info`.
- `getStats()`: preencher `averageSubRoomOccupancy`.
- `clampFanout`: aceitar `scope`, normalizando qualquer outro valor para `"room"`.
- `publish` não muda: em `subroom` só recebe o que atravessa.
- Testes em `coordinator.test.ts`: adoção de índice; `publish` privilegiado
  atravessa; `scope` inválido normaliza.

### 4.4 Shard — `src/realtime/shard.ts`, `shard/delivery.ts`

- `handleSend`, após o pipeline: se `config.fanout.scope === "subroom"` e o
  remetente **não** é privilegiado → `ack` imediato, depois
  `this.deliverLocal([{ t: "msg", m: message }], config)`. Privilegiado →
  `message.roomWide = true` e o caminho de `coordinator().publish` atual.
- `deliverLocal(events, config)`: com `batchWindowMs === 0` chama
  `this.fanout(events)` direto; senão enfileira em `pendingLocal` (mesmo teto
  e mesma política de descarte do coordinator: `MAX_PENDING_LOCAL`, perde o
  mais antigo) e agenda uma flush com `setTimeout` + `ctx.waitUntil`.
- `fanout(events)` (o RPC): se houver `pendingLocal`, descarrega antes,
  no mesmo lote (Q10). Se algum evento for `presence`, reescreve com
  `sub: this.ctx.getWebSockets().length` antes do `planDelivery`.
- `handleReaction`: em `subroom`, `this.fanout([reaction])` em vez de
  `coordinator().broadcast`.
- `resolveReply`: em `subroom`, reidrata com `listRoomMessages(env, roomId,
  RECENT_MESSAGE_WINDOW, null, { shardIndex })`.
- `delivery.ts`: `planDelivery(events, options?: { privilegedRoles })` —
  mensagens cujo `m.roles` intersecta `privilegedRoles` ou com `m.roomWide`
  recebem rank 0 (nunca amostradas). Teste em `delivery.test.ts`.
- Testes em `shard.test.ts`: ack antes da flush local; pendente local sai
  antes do fanout externo; `presence.sub` preenchido; reação local.

### 4.5 Persistência — `src/features/persistence/`

- `listRoomMessages(env, roomId, limit, cursor, options?: { shardIndex?: number })`
  — filtro `AND m.shard_index = ?` quando presente. Atualizar o comentário de
  cabeçalho do `index.ts` (contrato exportado).
- `GET /api/rooms/:roomId/messages?sub=N` passa o filtro. Teste em
  `history.test.ts`.

### 4.6 Sala e observabilidade — `src/features/room/`, `src/features/observability/`

- `PATCH /config` já aceita `fanout`; passa a aceitar `maxSocketsPerShard`
  (só o tipo mudou). Validar inteiro ≥ 1.
- Painel: rótulo "modo: sub-salas" quando `scope === "subroom"`, e a coluna de
  shards é apresentada como sub-salas. Sem endpoint novo.

### 4.7 Cliente e ferramentas — `public/`, `tools/loadtest/`

- `public/app.js`: presença "N assistindo · sala #k · M aqui"; selo "para
  todos" em `roomWide`; seletor de sub-sala visível só para papéis
  privilegiados, que reconecta com `?sub=N`.
- `tools/loadtest/run.mjs`: registrar `shardIndex` do `hello` por cliente;
  relatório com sub-salas abertas e ocupação mín/máx; flag `--scope
  room|subroom` no anúncio. `presets.ts` (`src/features/loadtest/`): `medium`
  e acima com `fanout.scope: "subroom"`, `shardCount: 1`,
  `maxSocketsPerShard: 2000`.
- `tools/loadtest/cost.mjs`: chamadas de DO no fanout só para mensagens
  privilegiadas quando `scope === "subroom"`.

### 4.8 Integração — `tests/subrooms.test.ts`

Os cenários da Q18, usando `tests/helpers/client.ts`. Fixar
`maxSocketsPerShard: 1` para forçar a sondagem sem abrir milhares de sockets.

### 4.9 Documentação

- `README.md`: seção "Sub-salas" (o que é, a receita
  `PATCH {"fanout":{"scope":"subroom"},"shardCount":1,"maxSocketsPerShard":2000}`,
  o que atravessa e o que não, e o que **não** está feito: fusão ao esvaziar,
  amigos na mesma sub-sala).
- `PLAN.md` §2: parágrafo sobre o modo sub-sala e o que ele faz com o
  coordinator. `docs/LOADTEST.md` §5.2: a receita passa a usar sub-salas.
- Este arquivo: atualizar a nota de estado no topo para "implementado" com o
  hash do commit.

### 4.10 Critério de pronto

- `npm run check` verde (typecheck + toda a suíte no workerd).
- Uma sala com `scope: "room"` se comporta byte a byte como antes: os testes
  existentes passam sem edição de expectativa (mudar um teste antigo exige
  justificativa no commit).
- `tests/subrooms.test.ts` verde com os seis cenários.
- Relatório final lista cada item de §4.1–§4.9 como feito, ou o motivo de não.

## 5. O que medir depois (não faz parte da implementação)

Com sub-salas, o número que falta — o teto de **escrita** de um shard — vira
mensurável, porque o coordinator saiu do caminho: um run com
`scope: "subroom"`, `shardCount: 1`, `maxSocketsPerShard` alto e clientes
crescendo até a latência ceder mede o shard e nada mais. Esse número decide
`maxSocketsPerShard` para valer, e `shards = 300.000 ÷ esse número` deixa de
ser chute.
