# Gerador de carga

Abre N WebSockets contra um deploy, faz uma parte deles falar, e **dá um
veredito** — não só uma tabela. Node puro: `ws` já é devDependency e os JWTs são
assinados localmente, então não há nada para instalar e o run não gasta
requisições só para se preparar.

Os resultados medidos e o procedimento para os degraus grandes estão em
[`docs/LOADTEST.md`](../../docs/LOADTEST.md). Este arquivo é a referência da
ferramenta.

```bash
npm run db:migrate:local   # uma vez
npm run dev                # terminal 1 — http://127.0.0.1:8787
npm run loadtest -- --clients 25 --talkers 8 --rate 12 --duration 20   # terminal 2
```

`npm run loadtest -- <flags>` e `node tools/loadtest/run.mjs <flags>` são a mesma
coisa.

## As quatro fases

Um run não é uma curva plana, e cada fase existe por um motivo:

| fase | o quê | por quê |
|---|---|---|
| `ramp` | 60 s abrindo sockets e subindo a taxa | é onde o autoescalador e o limitador de borda são testados |
| `hold` | 30 s no máximo | **a única janela que o veredito julga** — um transiente não descreve o regime |
| `drain` | todos os sockets fechados de uma vez | é o que acontece quando a live acaba, e o jeito mais barato de achar estado que ninguém limpa |
| `done` | relatório, veredito, custo | |

## Presets

Seis janelas fixas com a mesma forma (60 s + 30 s), lidas da própria API para
que exista uma só fonte da verdade:

```bash
node tools/loadtest/run.mjs --preset smoke   # 1.000 conexões / 200 remetentes
node tools/loadtest/run.mjs --preset small   # 10.000 / 2.000
node tools/loadtest/run.mjs --preset medium  # 50.000 / 10.000
node tools/loadtest/run.mjs --preset large   # 100.000 / 20.000
node tools/loadtest/run.mjs --preset xlarge  # 200.000 / 35.000
node tools/loadtest/run.mjs --preset max     # 300.000 / 50.000
```

Um preset maior que `smoke` não cabe numa máquina. `--nodes N --node i` divide o
mesmo preset entre N geradores, cada um abrindo a sua fatia:

```bash
node tools/loadtest/run.mjs --preset medium --nodes 5 --node 2
```

## Flags

| Flag | Padrão | O quê |
|---|---|---|
| `--url` | `ws://127.0.0.1:8787` | origem do WebSocket; a origem HTTP é derivada dela |
| `--room` | `loadtest` | sala em que todo mundo entra |
| `--preset` | — | uma das seis janelas fixas; sobrescreve clients/talkers/ramp/duration |
| `--clients` | `20` | sockets a abrir |
| `--talkers` | todos | quantos enviam; o resto só assiste |
| `--rate` | — | mensagens por segundo somando **todos** os remetentes |
| `--per-talker-rate` | `0.1` | msg/s de cada remetente, quando `--rate` não é dado |
| `--ramp` | `5` | segundos até a carga cheia |
| `--duration` | `30` | segundos no máximo |
| `--nodes` / `--node` | `1` / `0` | divide um preset entre máquinas |
| `--jwt-secret` | `$JWT_HS256_SECRET`, senão `.dev.vars` | assina os tokens localmente |
| `--moderator-key` | `$MODERATOR_API_KEY`, senão `.dev.vars` | anuncia o run para a página pública |
| `--bypass-key` | `$LOADTEST_BYPASS_KEY`, senão `.dev.vars` | pula o limite de conexões da borda |
| `--no-announce` | — | não anuncia (use nas máquinas que não são a 0) |
| `--drain-timeout` | `30` | segundos esperando a sala esvaziar depois do dreno |
| `--json` | off | imprime o relatório como JSON |
| `--out <arquivo>` | — | grava o JSON num arquivo |
| `--help` | | ajuda; funciona sem servidor nenhum |

## O veredito

Seis critérios, avaliados só na janela do `hold`. O processo **sai com código 1**
quando algum reprova, 130 quando é interrompido, 0 quando passa.

```
  === verdict (judged on the 15s hold window only) ===
  ✓ ack p99                    75ms (limit 250ms)
  ✓ delivery p99               169ms (limit 1000ms)
  ✓ handshakes                 0/20 failed (0.00%, limit 0.50%)
  ✓ no acked message lost      284 acked, 284 came back
  ✓ presence converges         reported 20 vs 20 open (0.00% drift, limit 1.00%)
  ✓ shard ceiling respected    busiest shard held 6 of 5000
  PASS
```

Os limites estão em `verdict.mjs` (`SLO`). O quarto não tem tolerância: uma
mensagem confirmada que não voltou para quem escreveu é a falha que a
arquitetura inteira existe para não ter. Amostragem retém mensagens de
espectadores — nunca do remetente.

Um critério aparece como `–` (pulado) quando não houve medição, não quando
passou: `busiest shard held 0 of 5000` é uma medição que não aconteceu, e
declará-la aprovada seria mentir.

## O que ele mede

- **conexões** abertas / perdidas / ainda em handshake, e a maior presença que a
  sala relatou.
- **mensagens** enviadas, confirmadas, rejeitadas (por `RejectCode`) e sem
  resposta no fim.
- **fanout**: quantas mensagens cada cliente recebeu, em quantos frames de
  WebSocket, e quantas o teto por espectador reteve.
- **latência de ack** — remetente → shard → remetente: a velocidade da decisão do
  pipeline de entrada.
- **latência de entrega** — fim a fim: remetente → shard → coordinator → todos os
  shards → receptor. Medida pelo timestamp embutido no corpo, então todo cliente
  *receptor* contribui com uma amostra.
- **dreno**: quantos segundos a sala leva para voltar a zero presente depois de
  todo mundo desconectar junto.
- **timeline**: uma linha por segundo, com a fase.

`p50 / p95 / p99 / max` para as três latências, e as de ack e entrega aparecem
duas vezes: o run inteiro e só o `hold`. Amostras têm reservoir de 50 mil por
série, então um run longo continua barato.

`Ctrl-C` para mais cedo, imprime o relatório marcado `(partial)` e sai com 130 —
um run interrompido não é um veredito.

## Diagnóstico de saturação

Um relatório que diz "chegamos a 28.000 sockets" é inútil se não disser se
aquilo foi o teto do chat ou o teto do notebook. A seção `what saturated`
distingue:

```
  === what saturated ===
  · ephemeral ports: 28100 sockets against a range of 28231 (32768-60999).
    One machine cannot exceed this per destination IP — widen
    net.ipv4.ip_local_port_range or add a machine.
```

Ela reconhece portas efêmeras esgotadas, descritores (`EMFILE`), endereço local
indisponível (`EADDRNOTAVAIL`), handshake estourando por tempo (`ETIMEDOUT`) e
conexões recusadas pelo outro lado (`ECONNRESET`/`ECONNREFUSED`) — este último
sendo o único que aponta para o servidor, e não para o gerador.

## Custo

Duas contas, lado a lado:

- **estimada** a partir do que o próprio gerador contou, com a tabela de preços
  versionada em `cost.mjs`. Sai na hora.
- **medida** pelo GraphQL Analytics da Cloudflare, como delta antes/depois do
  run, quando `CF_API_TOKEN` e `CF_ACCOUNT_ID` existem. Correta, mas atrasa
  minutos e agrega por minuto — um run de 90 s cai mal nesse balde.

A divergência entre as duas é informação: ou o modelo de custo está incompleto,
ou o run fez algo que ninguém planejou.

## Lendo o resultado

- **rejeições `rate_limited` / `slow_mode` / `spam`** são os gates funcionando,
  não uma falha. A config padrão permite rajada de 5 e recarrega 1 token/s por
  usuário; um run com menos remetentes que `--rate` é estrangulado de propósito.
  Suba `--talkers` ou afrouxe a sala com `PATCH /api/rooms/:roomId/config`.
- **`sent` muito acima de `acked`** sem rejeições: os frames estão enfileirados e
  o shard está atrasado — procure na timeline o segundo em que começou.
- **entrega p99 subindo com ack p99 estável** aponta para o fanout
  (coordinator → shards), não para o pipeline de entrada.
- **o primeiro run contra uma sala nova reprova por cold start.** Medido: 371 ms
  de ack p99 na sala fria contra 87 ms no mesmo run repetido. Rode duas vezes e
  reporte o segundo, ou aqueça a sala antes.
- **`still handshaking` no fim, localmente**, significa que o `wrangler dev`
  saturou — não o desenho.

## O teto do ambiente local (medido)

O gargalo local é o proxy do `wrangler dev`, e ele cede por **frames por
segundo**, não por sockets. Nesta máquina (16 vCPU, 15 GB):

| sockets | msg/s entregues | ack p99 | resultado |
|---:|---:|---:|---|
| 25 | 164 | 87 ms | limpo |
| 50 | 348 | 103 ms | limpo |
| 100 | 666 | 69 ms | limpo |
| 200 | 1.302 | 1.457 ms | conecta tudo, latência vira segundos |
| 100 @ 60 msg/s | (~4.000) | — | o proxy morre com um `ERROR` vazio |

O log do wrangler mostra `Error in ProxyController` sem nenhum erro do lado do
Worker — não há limite de subrequest, memória ou exceção da aplicação
envolvidos. Para números acima disso, aponte `--url` para um deploy real.

Use a faixa até ~100 sockets / ~700 frames/s para comparar mudanças de código: é
onde a medição reflete o Worker e não a ferramenta.
