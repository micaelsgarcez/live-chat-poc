# live-chat-cloudflare

Chat ao vivo para picos de centenas de milhares de espectadores, inteiro na
Cloudflare: Workers na borda, Durable Objects para o realtime, KV para leitura
quente, D1 para a verdade, Queues para o que sai do caminho crítico e Cron para
o que não precisa ser em tempo real.

TypeScript, **vertical slice architecture**, e tudo roda **100% local** — sem
conta Cloudflare, sem deploy.

> **Estado: prova de conceito concluída.** O produto funciona ponta a ponta e foi
> medido em produção; o run de referência passa nos seis critérios. A meta de
> 300 mil conexões **não foi alcançada**, e a medição diz exatamente por quê —
> veja [E para 300 mil conexões?](#e-para-300-mil-conexões) e
> [`docs/LOADTEST.md`](docs/LOADTEST.md). Nenhum número aqui é extrapolado.

- `PLAN.md` — a arquitetura, o porquê de cada decisão e o cronograma.
- `CLAUDE.md` — as regras de trabalho no repositório (contratos congelados,
  limites entre fatias, estilo).

## Começando

```bash
npm install
npm run setup          # cria .dev.vars e aplica as migrations no D1 local
npm run dev            # http://127.0.0.1:8787
```

Abra `http://127.0.0.1:8787` — o link já entra na sala `demo` como **Anônimo**,
lendo o chat em tempo real; o apelido só é pedido na hora de escrever. O
cliente é uma réplica do chat do Twitch:
nomes coloridos por usuário com o texto sempre em branco, menções com `@` (a
sua destaca a mensagem inteira), respostas citando a mensagem original,
seletor de emotes e stickers animados, e ações só de ícone com tooltip —
responder e reagir para todo mundo, silenciar/apagar/banir só para moderador.

> Os emotes são glifos Unicode. Num sistema sem fonte de emoji colorida eles
> caem para o desenho monocromático da fonte; os stickers da aba GIFs são SVG
> desenhado à mão e não dependem de fonte nenhuma.

```bash
npm run check          # typecheck + a suíte inteira no runtime real do workerd
node tools/seed/seed.mjs --room demo --users 6 --messages 40
npm run loadtest -- --clients 25 --talkers 8 --rate 12 --duration 20
```

## Subir na Cloudflare em cinco minutos

Sem GitHub Actions, direto da sua máquina. Precisa de uma conta Cloudflare com o
plano Workers Paid (Durable Objects não existem no free).

```bash
npx wrangler login                 # abre o navegador
node tools/ci/provision.mjs        # cria KV, D1 e as três filas (idempotente)
                                   # e imprime os ids que os passos abaixo usam
```

Exporte o que ele imprimiu, mais dois secrets seus, e publique:

```bash
export CF_KV_ID=...  CF_D1_DATABASE_ID=...  CF_WORKER_NAME=live-chat
export JWT_HS256_SECRET=$(openssl rand -hex 32)
export MODERATOR_API_KEY=$(openssl rand -hex 32)

node tools/ci/render-wrangler-config.mjs                       # gera wrangler.deploy.json
npx wrangler d1 migrations apply CHAT_DB --remote --config wrangler.deploy.json
npx wrangler deploy --config wrangler.deploy.json

echo "$JWT_HS256_SECRET"  | npx wrangler secret put JWT_HS256_SECRET  --config wrangler.deploy.json
echo "$MODERATOR_API_KEY" | npx wrangler secret put MODERATOR_API_KEY --config wrangler.deploy.json

node tools/ci/verify-deploy.mjs --url https://<o-que-o-deploy-imprimiu>
```

`wrangler.jsonc` é um contrato congelado e descreve o mundo local; a config de
deploy é **gerada** a partir dele, então nenhum id da sua conta entra no git. O
passo a passo completo, incluindo o pipeline no GitHub Actions, está em
[`docs/CICD.md`](docs/CICD.md).

## Teste de carga

Seis janelas fixas — de mil a **300 mil conexões com 50 mil pessoas escrevendo** —
todas com a mesma forma: 60 s de rampa até o máximo, 30 s no máximo, e então
todo mundo desconecta de uma vez.

```bash
npm run loadtest -- --preset smoke --url wss://<seu-worker>
```

O gerador dá um **veredito**, não só uma tabela: seis critérios avaliados só na
janela dos 30 s no topo, PASS/FAIL por critério, e código de saída diferente de
zero quando reprova. Ele também diz *o que saturou* — porta efêmera, descritor,
CPU de TLS ou o servidor — porque "chegamos a 28 mil sockets" não vale nada se
não disser se aquilo foi o teto do chat ou o teto da máquina.

Enquanto um run acontece, a página pública mostra o alvo, a fase e **duas
contagens lado a lado**: o que o gerador acha que abriu e o que a sala relata.
Quando divergem, a divergência é o achado.

**Os números medidos, o que não foi rodado e por quê, e o procedimento para os
degraus grandes estão em [`docs/LOADTEST.md`](docs/LOADTEST.md).** Nada ali é
extrapolado: `max` exige ~30 máquinas de carga e não foi executado.

### Demonstração

O teste rodando contra a produção, com os dados ao vivo na página pública: 400
espectadores, 40 remetentes, coalescência e amostragem ligadas, e o painel
mostrando lado a lado o que o gerador abriu e o que a sala relata.

https://github.com/user-attachments/assets/3b09292f-2980-4306-8af8-2b020fddd9ab

## Como uma mensagem viaja

```
browser ──WS──► Worker de borda        auth (JWT) → ban (KV/D1) → rate-limit → hash do shard
                      │
                      ▼
                 ChatShard #k          pipeline: base-guard → rate-limit → slow-mode
                      │                          → spam → moderação síncrona
        publish ──────┤                          e então: ack + buffer de persistência
                      ▼
               RoomCoordinator         config autoritativa, registro de shards, escala
                      │
        fanout ───────┴──────► ChatShard #0..#N ──► sockets (saída é de graça)
```

Fora do caminho quente: `chat-persist` grava lotes em D1, `chat-moderation` faz
a revisão pesada e emite delete retroativo, e o Cron (mais o alarm do
coordinator) recalcula o ranking para o KV.

## Sub-salas

Sub-salas são um modo opt-in para lives em que o fanout global virou o teto. Um
`ChatShard` passa a ser uma sub-sala: mensagens e reações comuns ficam entre os
sockets daquele shard, são confirmadas ali e não esperam o `RoomCoordinator`.
Ative em runtime, começando por uma sub-sala e deixando a ocupação abrir as
próximas automaticamente:

```bash
curl -X PATCH https://<seu-worker>/api/rooms/<sala>/config \
  -H "x-moderator-key: $MODERATOR_API_KEY" -H 'content-type: application/json' \
  -d '{"fanout":{"scope":"subroom"},"shardCount":1,"maxSocketsPerShard":2000}'
```

Mensagens de moderador, admin e sistema continuam passando pelo coordinator e
chegam a todos, assim como delete retroativo, ban, configuração e presença
total. Mensagens comuns, reações, respostas e menções ficam locais. O cliente
mostra o total da live e quantas pessoas estão na sub-sala; papéis privilegiados
podem escolher uma com `?sub=N`. O histórico aceita o mesmo filtro, enquanto a
consulta sem `sub` preserva a visão global de moderação.

## Endpoints

| Método | Rota | O quê |
|---|---|---|
| GET | `/ws/:roomId?token=` | upgrade de WebSocket (atalho da demo) |
| GET | `/api/rooms/:roomId/connect` | o mesmo upgrade, nome canônico |
| POST | `/api/dev/token` | token HS256 local (bloqueado em produção) |
| GET | `/api/me` | identidade do token apresentado |
| GET/PATCH | `/api/rooms/:roomId/config` | configuração da sala (PATCH = moderador) |
| GET | `/api/rooms/:roomId/stats` | shards registrados, presença, contadores |
| GET | `/api/rooms/:roomId/messages` | histórico paginado (`limit`, `before`, `sub`), com a citação da resposta |
| GET | `/api/rooms/:roomId/ranking` | ranking pronto do KV (`?refresh=1` recalcula) |
| GET/POST | `/api/rooms/:roomId/bans` | listar / aplicar ban (moderador) |
| DELETE | `/api/rooms/:roomId/bans/:userId` | remover ban |
| POST | `/api/rooms/:roomId/moderation/delete` | delete retroativo |
| POST | `/api/rooms/:roomId/moderation/mute` | silenciar usuário |
| GET | `/api/rooms/:roomId/moderation/actions` | auditoria |
| GET | `/api/rooms/:roomId/loadtest` | run de carga em andamento + a escada de presets (público) |
| POST/PATCH/DELETE | `/api/rooms/:roomId/loadtest` | anunciar / reportar / encerrar um run (moderador) |

Moderador: header `x-moderator-key` (veja `.dev.vars`) ou um JWT com papel
`moderator`/`admin`.

## CI/CD

`.github/workflows/ci.yml` roda em toda PR e todo push: typecheck, a suíte
inteira no workerd com o resultado agrupado **por funcionalidade**, o build do
Worker e um smoke funcional contra um `wrangler dev` de verdade — nada disso
precisa de conta na Cloudflare.

`.github/workflows/deploy.yml` publica todo push na `main` que passar no CI:
migrations no D1 remoto, `wrangler deploy`, secrets sincronizados e uma
verificação na URL publicada que abre um WebSocket e confere o ack.

A config de deploy é **gerada** a partir do `wrangler.jsonc` (que é um contrato
congelado e descreve o mundo local), então os ids da conta ficam na configuração
do repositório e não no git.

O deploy sai como `ENVIRONMENT=demo`: a rota que emite token continua ligada, de
modo que qualquer visitante entra na sala `demo`, escreve e pode se declarar
moderador para experimentar apagar, silenciar e banir. É de propósito — as
regras só se mostram para quem consegue tentar quebrá-las. `CF_ENVIRONMENT=production`
desliga essa rota quando existir um emissor de tokens de verdade.

O passo a passo — provisionamento, secrets e variables — está em
[`docs/CICD.md`](docs/CICD.md).

## Estrutura

```
src/shared/      contratos congelados (protocolo, pipeline, ports, config)
src/features/    uma pasta por fatia: rotas + domínio + testes
src/realtime/    ChatShard e RoomCoordinator
tests/           testes que atravessam fatias + TestClient de WebSocket
tools/           gerador de carga, seeder e as ferramentas do pipeline (tools/ci/)
migrations/      schema do D1
.github/         CI e deploy contínuo
```

Regra de dependência: uma fatia importa `src/shared/*` e o `index.ts` público de
outra fatia — nunca arquivos internos de outra fatia. `src/features/registry.ts`
é o único módulo que conhece todas.

## Números medidos em produção

Contra o deploy real, sala com 8 shards, coalescência de 100 ms e teto de
4 msg/s por espectador. Todos os runs abriram 100 % dos sockets pedidos, com
zero handshake perdido e zero mensagem confirmada e não entregue.

O run de referência — **400 espectadores, 40 remetentes, 5 minutos no topo** —
passou nos seis critérios:

| | resultado | limite |
|---|---:|---:|
| ack p99 | **232 ms** | 250 ms |
| entrega fim a fim p99 | **344 ms** | 1 s |
| handshakes perdidos | 0 de 400 | 0,5 % |
| mensagem confirmada e não entregue | 0 de 3.602 | zero |
| presença vs sockets abertos | 0,25 % | 1 % |

### O que custa latência, e o que não custa

Um 2×2 que isola as duas variáveis:

| | 400 espectadores | 1.000 espectadores |
|---|---:|---:|
| **12 msg/s entrando** | ack p99 232 ms | ack p99 601 ms |
| **30 msg/s entrando** | ack p99 236 ms | — |

**Taxa de entrada é de graça. Conexão custa.** 2,5× mais mensagens não mudou
nada; 2,5× mais conexões multiplicou a latência por 2,6.

### O botão que funciona

A janela de coalescência, com 1.000 conexões:

| `batchWindowMs` | ack p99 | entrega p99 |
|---:|---:|---:|
| 100 ms | 601 ms | 607 ms |
| 250 ms | 395 ms | 636 ms |
| **500 ms** | **317 ms** | 803 ms |

Quem escreve espera quase metade; quem assiste espera mais, e os dois ficam
dentro do orçamento. Chat de live é assimétrico — milhares assistem, dezenas
escrevem — então comprar latência de envio com latência de entrega é o câmbio
certo. É `PATCH` na config da sala, sem deploy.

### O botão que **não** funciona

| shards | sockets por shard | ack p99 |
|---:|---:|---:|
| 8 | 126 | 601 ms |
| 20 | 53 | **922 ms** |

Menos sockets por shard e a latência piorou 53 %. `RoomCoordinator.fanout` chama
todos os shards e **espera todos**: a rodada dura o *máximo* entre eles, e o
máximo de 20 amostras é pior que o de 8. Dividir mais a sala só multiplica as
chances de existir um lento.

> Isso derrubou duas hipóteses nossas. `MAX_SOCKETS_PER_SHARD` não é o botão que
> parecia ser — se mais shards pioram, baixar o teto por shard piora junto. E o
> custo por socket no fanout não era a desserialização do attachment: remover
> aquele trabalho por socket por rodada mudou o ack de 601 ms para 601 ms.

## E para 300 mil conexões?

A pergunta que a POC existe para responder. **A resposta medida é: a arquitetura
como está não chega lá** — e o motivo não é o que o `PLAN.md` supunha.

300 mil sockets precisam de pelo menos 60 shards para caberem em
`maxSocketsPerShard` de 5.000. Mas **20 shards já são piores que 8**, porque o
coordinator espera todos. O desenho tem uma contradição interna: você precisa de
muitos shards para segurar os sockets, e muitos shards deixam o coordinator
lento. O gargalo não é socket, não é CPU, não é taxa de mensagem — é um `await`.

### O que 300k / 30k realmente pede

Com 30 mil remetentes (10 % das conexões) a 1 mensagem a cada 30 s:

| | valor | de onde vem |
|---|---:|---|
| entrada | ~1.000 msg/s | 30k ÷ 30s — **medido como irrelevante** |
| saída, teto de 4 msg/s | **1,2 M frames/s** | 300k × 4 |
| saída, teto de 20 msg/s | **6 M frames/s** | 300k × 20 |

O teto por espectador é o que decide tudo: sem ele, 1.000 msg/s × 300 mil
espectadores seriam 300 milhões de frames por segundo, que não é caro — é
impossível.

### O que faltaria construir

1. **O coordinator não pode esperar os shards.** Ele soma `delivered` de cada um
   para devolver um `PublishResult` que o shard **descarta** — está se
   bloqueando no resultado de um trabalho que ninguém lê.
2. **Fila por shard**, para que um shard lento atrase só os próprios
   espectadores em vez da sala inteira. É o que faria mais shards finalmente
   ajudar.
3. **Fanout em árvore.** Nenhum objeto deve falar com centenas de outros:
   coordinator → relays → folhas. Com o fator de ramificação de 32 que o código
   já usa, dois níveis alcançam 1.024 shards.
4. **Medir o teto de escrita de um shard.** Este número nós **não temos** — o
   coordinator saturou antes, então todos os experimentos mediram ele, não o
   shard. É a primeira coisa a medir depois do item 1.

Sem o item 4 qualquer contagem de shards é chute. Com ele, a conta fecha
sozinha: `shards = 300.000 ÷ sockets por shard`, com o teto por espectador
escolhido para o total de frames/s caber.

**O teto local do `wrangler dev`** é de ~700 frames/s limpos e ~1.300
degradados; acima disso o proxy morre sem nenhum erro do lado do Worker. Não é
limite da arquitetura, é da ferramenta de desenvolvimento.

Os números completos, o método e o que não foi executado estão em
[`docs/LOADTEST.md`](docs/LOADTEST.md).
