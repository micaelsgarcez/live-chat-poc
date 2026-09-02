# Teste de carga

Este documento tem duas metades e elas não devem ser confundidas.

A primeira é o que foi **medido**, nesta máquina, com os comandos que estão
aqui. A segunda é o **procedimento** para os degraus grandes — até 300 mil
conexões — que **não foram executados**, porque executá-los exige uma frota de
máquinas que este projeto deliberadamente não provisiona.

Nenhum número aqui é extrapolado. Se um degrau não foi rodado, ele aparece como
não rodado.

---

## 1. A escada

Seis janelas fixas, todas com a mesma forma: **60 s de rampa até o máximo, 30 s
no máximo**. Só as duas variáveis que importam mudam entre elas.

| preset | conexões | remetentes | shards | máquinas de carga | rodado? |
|---|---:|---:|---:|---:|---|
| `smoke` | 1.000 | 200 | 1 | 1 | não |
| `small` | 10.000 | 2.000 | 2 | 1 | não |
| `medium` | 50.000 | 10.000 | 10 | 5 | não |
| `large` | 100.000 | 20.000 | 20 | 10 | não |
| `xlarge` | 200.000 | 35.000 | 40 | 20 | não |
| `max` | 300.000 | 50.000 | 60 | 30 | não |

A fonte da verdade é `src/features/loadtest/presets.ts`; o gerador lê a lista da
própria API (`GET /api/rooms/:roomId/loadtest`).

**A regra da escada: nenhum degrau roda antes de o anterior passar.** Pular
direto para `max` gasta dinheiro descobrindo um defeito que `smoke` acharia de
graça.

## 2. Critério de aprovação

Seis critérios, avaliados **apenas na janela dos 30 s no máximo**. A rampa é um
transiente, e julgar um sistema pelo transiente é como se acaba otimizando a
coisa errada.

| critério | limite |
|---|---|
| ack p99 | < 250 ms |
| entrega fim a fim p99 | < 1 s |
| handshakes perdidos | < 0,5 % |
| mensagem confirmada e não entregue | **zero, sem tolerância** |
| presença informada vs sockets abertos | dentro de 1 % |
| sockets no shard mais cheio | ≤ `maxSocketsPerShard` |

O gerador imprime PASS/FAIL por critério e **sai com código diferente de zero
quando reprova**. Um teste de carga que não pode reprovar é uma demonstração.

O critério sem tolerância é o quarto. Amostragem retém mensagens de
*espectadores*; nunca do remetente. Uma mensagem confirmada que não voltou para
quem a escreveu é a falha que esta arquitetura inteira existe para não ter.

---

## 3. O que foi medido

**Ambiente:** WSL2, 16 vCPU, 15 GB de RAM, Node 22.22.1, `wrangler dev` local,
sala com 4 shards. `ulimit -n` = 1.048.576; `ip_local_port_range` =
32768–60999, ou seja **28.231 sockets por IP de destino** — que não chegou a ser
o limite, porque outra coisa cede muito antes.

### 3.1 A escada local — 12 msg/s, 1/4 dos clientes falando

| sockets | entregues/s | handshake p99 | ack p50 | ack p99 | entrega p99 | veredito |
|---:|---:|---:|---:|---:|---:|---|
| 25 (sala fria) | 102 | — | — | 371 ms | 366 ms | **FAIL** |
| 25 (sala quente) | 164 | 121 ms | 25 ms | 87 ms | 72 ms | PASS |
| 50 | 348 | 143 ms | 32 ms | 103 ms | 94 ms | PASS |
| 100 | 666 | 159 ms | 27 ms | 69 ms | 60 ms | PASS |
| 200 | 1.302 | **2.154 ms** | 701 ms | **1.457 ms** | **1.250 ms** | **FAIL** |

Todos os runs abriram 100 % dos sockets pedidos, com zero handshake perdido e
zero mensagem confirmada e não entregue. O dreno (todos desconectando de uma
vez) devolveu a sala a zero presente em 1–3,5 s em todos eles.

Duas coisas nessa tabela merecem ser ditas em voz alta:

**O primeiro run contra uma sala fria reprova por cold start.** 371 ms de ack
p99 contra 87 ms no mesmo run repetido com a sala quente — quatro vezes. É o
Durable Object subindo. Não é um defeito, mas é uma característica que qualquer
medição precisa isolar, e um run único contra uma sala nova mede o cold start,
não a sala.

**O gargalo é frames por segundo, não sockets.** 100 sockets passam com folga a
666 frames/s; 200 sockets a 1.302 frames/s degradam para latência de segundos.
E é o `wrangler dev` que cede, não o Worker: 100 sockets a 60 msg/s (≈4.000
frames/s) derrubam o processo inteiro com um `ERROR` vazio do ProxyController,
sem nenhum erro do lado do Worker.

> **Teto medido desta máquina:** ~700 frames/s limpo, ~1.300 frames/s degradado,
> acima disso o `wrangler dev` morre. Isso é limite da ferramenta de
> desenvolvimento, **não da arquitetura** — e é exatamente por isso que os
> degraus acima de `smoke` precisam de um deploy de verdade.

### 3.2 Coalescência e amostragem — o mesmo carregamento, com e sem

20 sockets, 10 remetentes, 20 msg/s oferecidos. À esquerda a sala como era antes
deste trabalho; à direita a mesma sala com janela de coalescência de 100 ms e
teto de 8 msg/s por espectador.

| | desligado | ligado | |
|---|---:|---:|---|
| ack p50 | 224 ms | **13 ms** | 17× |
| ack p99 | 580 ms | **75 ms** | 7,7× |
| entrega p99 | 551 ms | **169 ms** | 3,3× |
| mensagens entregues/s | 253 | 121 | (amostrado de propósito) |
| frames de WebSocket | 7.392 | **2.658** | 2,8× menos |
| retidas pelo teto | 0 | 4.084 | |
| chamadas de DO no fanout | 1.604 | **1.168** | 27 % menos |
| **veredito** | **FAIL** | **PASS** | |

O mesmo carregamento que reprovava passa. O preço está explícito na tabela: o
espectador vê 121 msg/s em vez de 253, e a UI diz isso na tela
(`mostrando 121 de 253 msg/s`) em vez de fingir que entregou tudo.

Reproduzindo:

```bash
npm run dev   # terminal 1

# terminal 2 — sem coalescência
curl -X PATCH localhost:8787/api/rooms/cmp-off/config \
  -H "x-moderator-key: $MODERATOR_API_KEY" -H 'content-type: application/json' \
  -d '{"fanout":{"batchWindowMs":0,"maxPerViewerPerSecond":0,"alwaysDeliverOwn":true}}'
npm run loadtest -- --room cmp-off --clients 20 --talkers 10 --rate 20 --ramp 10 --duration 15

# com coalescência de 100 ms e teto de 8 msg/s por espectador
curl -X PATCH localhost:8787/api/rooms/cmp-on/config \
  -H "x-moderator-key: $MODERATOR_API_KEY" -H 'content-type: application/json' \
  -d '{"fanout":{"batchWindowMs":100,"maxPerViewerPerSecond":8,"alwaysDeliverOwn":true}}'
npm run loadtest -- --room cmp-on --clients 20 --talkers 10 --rate 20 --ramp 10 --duration 15
```

### 3.3 Custo

Os runs acima custariam, pelo modelo em `tools/loadtest/cost.mjs`, entre
**US$ 0,0003 e US$ 0,0005 cada** — números de brinquedo, porque a carga é de
brinquedo. O que o modelo diz sobre um run `max` de verdade está na §5.

Nenhum número **medido** de custo aparece aqui: `CF_API_TOKEN` e `CF_ACCOUNT_ID`
não estavam configurados nesta máquina, então o gerador reporta
`measured: not available`. Com eles, ele lê os analytics da conta antes e depois
do run e mostra os dois lado a lado.

---

## 4. Por que 50 mil pessoas escrevendo não é entregável — e o que se faz

A conta que motivou metade deste trabalho:

> 50.000 remetentes a **1 mensagem a cada 10 s** são 5.000 msg/s. Com 300.000
> conectados, isso é **1,5 bilhão de frames por segundo** (~300 GB/s de saída) e
> **300.000 chamadas de coordinator→shard por segundo**.

Não é caro: é fisicamente impossível. E ninguém lê 5.000 mensagens por segundo.
Chat de live de verdade — Twitch, YouTube — não entrega tudo para todo mundo.

Duas mudanças, ambas configuráveis em runtime pelo `PATCH .../config` e ambas
**desligadas por padrão**:

**Coalescência (`fanout.batchWindowMs`).** O coordinator segura uma janela de
mensagens e manda **uma** chamada por shard com a janela inteira, em vez de uma
chamada por mensagem por shard. A 5.000 msg/s e 60 shards, uma janela de 100 ms
troca 300.000 chamadas/s por 600. O remetente não paga a janela: o shard
confirma antes de o coordinator descarregar — o teste `acks the sender without
waiting out the coalescing window` em `tests/fanout-sampling.test.ts` prende esse
comportamento.

**Amostragem (`fanout.maxPerViewerPerSecond`).** Acima do teto, cada socket
recebe uma amostra da janela — sorteada por espectador, então dois espectadores
não veem o mesmo recorte, e re-sorteada a cada fanout, então nenhuma mensagem é
sistematicamente a descartada. O frame carrega `dropped`, e o cliente mostra
`mostrando X de Y msg/s`. **A sua própria mensagem nunca é amostrada.**

A implementação está em `src/realtime/shard/delivery.ts`, e o comentário no topo
explica o truque que evita um `JSON.stringify` por socket.

---

## 5. Como rodar os degraus grandes

Não rodamos. Este é o procedimento para quem quiser.

### 5.1 O que é preciso

- Um deploy de verdade (§ README, "Subir na Cloudflare"). O `wrangler dev` morre
  perto de 1.300 frames/s, três ordens de grandeza abaixo de `max`.
- Uma máquina de carga a cada ~10 mil sockets (coluna `machines` da escada).
- Portas efêmeras: cada máquina abre no máximo `ip_local_port_range` sockets por
  IP de destino. O padrão do Linux dá ~28 mil; `sysctl -w
  net.ipv4.ip_local_port_range="1024 65535"` sobe para ~64 mil.
- `ulimit -n` acima do número de sockets da máquina.

### 5.2 Antes do run

**Provisione os shards.** O run oficial fixa `shardCount` antes de começar; se
deixar autoescalar, o denominador do `hash(sala:usuário) % shardCount` muda no
meio da rampa e a colocação re-hasheia, perdendo o estado quente dos gates.

```bash
curl -X PATCH https://<seu-worker>/api/rooms/loadtest/config \
  -H "x-moderator-key: $MODERATOR_API_KEY" -H 'content-type: application/json' \
  -d '{"shardCount":60,"fanout":{"batchWindowMs":100,"maxPerViewerPerSecond":20,"alwaysDeliverOwn":true}}'
```

**Arme o bypass do limite de conexões — e só então.** 30 máquinas abrindo 300 mil
sockets são exatamente a forma que `EDGE_CONNECTIONS_PER_MINUTE` (60/min por IP)
existe para barrar. O bypass é assinado por HMAC com janela de 5 minutos e **não
existe** enquanto o secret não estiver configurado:

```bash
export LOADTEST_BYPASS_KEY=$(openssl rand -hex 32)
echo "$LOADTEST_BYPASS_KEY" | npx wrangler secret put LOADTEST_BYPASS_KEY
```

O console público mostra, na tela, que o bypass está ativo — para nenhum número
obtido com ele ser confundido com um número normal. As pessoas na sala pública
continuam sujeitas ao limite.

**Depois do run, desarme:**

```bash
npx wrangler secret delete LOADTEST_BYPASS_KEY
```

### 5.3 O run

Cada máquina roda a sua fatia do mesmo preset:

```bash
# máquina i de N, 0-based
node tools/loadtest/run.mjs \
  --preset max --nodes 30 --node "$i" \
  --url wss://<seu-worker> --room loadtest \
  --jwt-secret "$JWT_HS256_SECRET" \
  --moderator-key "$MODERATOR_API_KEY" \
  --bypass-key "$LOADTEST_BYPASS_KEY" \
  --out "run-$i.json"
```

Os tokens são assinados localmente: 300 mil chamadas a `POST /api/dev/token`
dentro da rampa seriam um segundo teste de carga rodando junto do primeiro.

A máquina 0 (só ela, para não escreverem por cima umas das outras) anuncia o run
com `--moderator-key`; as outras rodam com `--no-announce`.

### 5.4 Enquanto roda

O console público (`/console`, ou a aba de observabilidade da demo) mostra um
painel com o alvo, a fase, e **duas contagens lado a lado**: o que o gerador
acha que abriu e o que a sala relata. Elas devem bater. Quando não batem, a
divergência é o achado — e por isso a página mostra as duas em vez de uma média.

### 5.5 Teto de gasto

Um run `max` completo, pelo modelo de `cost.mjs`: a hibernação de WebSocket faz
300 mil sockets ociosos custarem quase nada em duração; o custo real são as
chamadas de DO do fanout — **ordem de US$ 1 a 5 por run**. O risco não é o preço
nominal, é um run que **não para**. O gerador mata tudo em SIGINT e num prazo
absoluto, mas configure um alerta de orçamento na conta antes do primeiro run
grande, e **nunca dispare `max` a partir de CI**.

---

## 6. O run que cabe numa máquina só

Este é o teste que dá para fazer **hoje**, sem frota: uma máquina contra o deploy
de produção. Contra um deploy o proxy do `wrangler dev` sai da frente, e o teto
deixa de ser ~1.300 frames/s e passa a ser o da própria máquina.

O que limita uma máquina, em ordem:

| limite | nesta máquina | consequência |
|---|---:|---|
| portas efêmeras por IP de destino | 28.231 | teto absoluto de sockets |
| descritores (`ulimit -n`) | 1.048.576 | não é o gargalo |
| CPU de um processo Node | 1 núcleo dos 16 | o teto de frames/s |

Ou seja: **`smoke` (1.000) e `small` (10.000) cabem; `medium` (50.000) não cabe**,
porque 50 mil sockets excedem a faixa de portas. Subir a faixa para `1024 65535`
com `sysctl` leva a ~64 mil e coloca `medium` ao alcance, mas exige root.

### Passo a passo

**1. Deploy em produção.** Merge da PR → o workflow publica sozinho. Anote a URL
que o job imprime.

```bash
gh run watch                                    # acompanha o deploy
node tools/ci/verify-deploy.mjs --url https://<seu-worker>
```

**2. Prepare a sala.** Fixe `shardCount` antes do run — se deixar autoescalar, o
denominador do `hash(sala:usuário) % shardCount` muda no meio da rampa e a
colocação re-hasheia. Para 10 mil conexões, 2 shards:

```bash
export WORKER=https://<seu-worker>
export MODERATOR_API_KEY=...                    # o mesmo do secret do deploy
export JWT_HS256_SECRET=...

curl -X PATCH "$WORKER/api/rooms/loadtest/config" \
  -H "x-moderator-key: $MODERATOR_API_KEY" -H 'content-type: application/json' \
  -d '{"shardCount":2,"fanout":{"batchWindowMs":100,"maxPerViewerPerSecond":20,"alwaysDeliverOwn":true}}'
```

**3. Arme o bypass — e só agora.** Uma máquina abrindo 10 mil sockets é
exatamente a forma que o limite de 60 conexões/minuto por IP existe para barrar.

```bash
export LOADTEST_BYPASS_KEY=$(openssl rand -hex 32)
node tools/ci/render-wrangler-config.mjs
echo "$LOADTEST_BYPASS_KEY" | npx wrangler secret put LOADTEST_BYPASS_KEY --config wrangler.deploy.json
```

**4. Levante os limites do sistema operacional** (na sessão do shell, sem root):

```bash
ulimit -n 1048576
cat /proc/sys/net/ipv4/ip_local_port_range     # confira quantos sockets cabem
```

**5. Suba a escada, um degrau por vez.** Nenhum degrau roda antes de o anterior
passar. Deixe a página aberta em `$WORKER` — o painel mostra o run ao vivo.

```bash
# degrau 1 — 1.000 conexões, 200 remetentes
npm run loadtest -- --preset smoke --url "wss://<seu-worker>" \
  --bypass-key "$LOADTEST_BYPASS_KEY" --out smoke.json

# degrau 2 — 10.000 conexões, 2.000 remetentes (o teto de uma máquina)
npm run loadtest -- --preset small --url "wss://<seu-worker>" \
  --bypass-key "$LOADTEST_BYPASS_KEY" --out small.json
```

O processo sai com **0 se passou, 1 se algum critério reprovou**. Rode o `smoke`
duas vezes: o primeiro run contra uma sala fria reprova por cold start, e é o
segundo que descreve o regime.

**6. Desarme o bypass.** Não é opcional — a demo é pública.

```bash
npx wrangler secret delete LOADTEST_BYPASS_KEY --config wrangler.deploy.json
```

**7. Devolva a sala ao padrão**, se quiser a demo como era:

```bash
curl -X PATCH "$WORKER/api/rooms/loadtest/config" \
  -H "x-moderator-key: $MODERATOR_API_KEY" -H 'content-type: application/json' \
  -d '{"fanout":{"batchWindowMs":0,"maxPerViewerPerSecond":0,"alwaysDeliverOwn":true}}'
```

### O que olhar no resultado

- **O veredito**, antes de qualquer outra coisa. Seis linhas, uma por critério.
- **`what saturated`** — se disser `ephemeral ports`, o teto foi a máquina e o
  chat não foi testado no limite dele. Se disser `ECONNRESET` ou `ETIMEDOUT`, aí
  sim o outro lado cedeu.
- **`ack (hold)` vs `delivery (hold)`** — entrega subindo com ack estável aponta
  para o fanout, não para o pipeline de entrada.
- **`drain`** — quantos segundos a sala levou para voltar a zero depois de todo
  mundo desconectar junto. É onde estado mal limpo aparece.
- **`cost`** — com `CF_API_TOKEN` e `CF_ACCOUNT_ID` no ambiente, o estimado e o
  medido saem lado a lado.

Guarde os `.json`: são a entrada para atualizar a §3 deste documento com números
de produção, que é o que falta para ele deixar de ser um documento sobre um
`wrangler dev`.

## 7. O que ainda não foi respondido

Honestidade sobre os buracos:

- **Autoescala durante a rampa.** O run oficial fixa `shardCount`. O run que
  deixa autoescalar — e mede o custo do re-hash no meio da rampa — não foi feito.
  É onde eu apostaria que existe um defeito esperando.
- **Hibernação.** O PLAN.md promete que "saída é de graça" e que sockets ociosos
  quase não custam. O run que segura 60 s ociosos depois do topo para ver a
  hibernação assumir não foi feito.
- **Todo degrau acima de `smoke`.** Nenhum foi executado. Os números da §3 são de
  runs de dezenas de sockets contra um `wrangler dev`.
