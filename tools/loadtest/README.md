# Load generator

Opens N WebSockets against a local `wrangler dev`, makes a subset of them talk
at a fixed **total** rate, and reports what the room did under that pressure.
Pure Node — `ws` is already a devDependency, there is nothing to install.

```bash
npm run db:migrate:local   # once
npm run dev                # terminal 1 — http://127.0.0.1:8787
npm run loadtest -- --clients 50 --rate 20 --duration 30   # terminal 2
```

`npm run loadtest -- <flags>` and `node tools/loadtest/run.mjs <flags>` are the
same thing.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `ws://127.0.0.1:8787` | WebSocket origin; the HTTP origin for `POST /api/dev/token` is derived from it |
| `--room` | `loadtest` | room id every client joins |
| `--clients` | `20` | sockets to open |
| `--rate` | `10` | messages per second across **all** talkers combined |
| `--duration` | `30` | seconds of sending after the ramp |
| `--ramp` | `5` | seconds to reach full client count and full rate |
| `--talkers` | all clients | how many clients send; the rest only listen |
| `--json` | off | print the report as JSON (timeline included) instead of text |
| `--help` | | usage; works with no server running |

Each client gets its own dev token from `POST /api/dev/token` as `lt-<index>`,
which is also what the edge hashes on — so more clients means more shards
actually exercised.

## What it measures

- **connections** opened / failed / still open, plus the highest `presence`
  count a single shard reported (clients only ever see their own shard).
- **messages** sent, acked, rejected (broken down by `RejectCode`) and how many
  are still unanswered at the end.
- **fanout frames**: every `msg` frame received by every client. With 50 viewers
  and 10 msg/s this is ~500 frames/s — that ratio is the whole point of the
  shard/coordinator split.
- **ack latency** — sender → shard → sender, i.e. how fast the inbound pipeline
  decides.
- **delivery latency** — end to end: sender → shard → coordinator → every shard
  → receiver. Measured by embedding the send timestamp in the body, so every
  *receiving* client contributes a sample.
- **timeline**: one row per elapsed second with open sockets / sent / acked /
  rejected / frames.

`p50 / p95 / p99 / max` are reported for all three latencies. Samples are
reservoir-capped at 50k per series so a long run stays cheap.

`Ctrl-C` stops early and still prints the report, marked `(partial)`.

## Scenarios

```bash
# smoke: does the room work at all?
node tools/loadtest/run.mjs --clients 5 --rate 2 --duration 10 --ramp 1

# the PLAN.md peak, low end: 10 msg/s with 100 viewers
node tools/loadtest/run.mjs --clients 100 --talkers 20 --rate 10 --duration 60 --ramp 10

# the PLAN.md peak, high end: 50 msg/s with 200 viewers
node tools/loadtest/run.mjs --clients 200 --talkers 40 --rate 50 --duration 60 --ramp 15

# fanout-heavy: many listeners, few talkers — this is the shape a live stream has
node tools/loadtest/run.mjs --clients 300 --talkers 5 --rate 25 --duration 45 --ramp 20

# machine-readable, for a before/after comparison
node tools/loadtest/run.mjs --clients 50 --rate 20 --duration 30 --json > after.json
```

## Reading the result

- **`rate_limited` / `slow_mode` / `spam` rejections** are the gates doing their
  job, not a failure. The default room config allows a burst of 5 and refills 1
  token per second per user, so a run with fewer talkers than `--rate` will be
  throttled on purpose. Raise `--talkers` (or relax the config through
  `PATCH /api/rooms/:roomId/config`) to push real throughput.
- **`sent` far above `acked`** with no rejections means frames are queued and the
  shard is behind — look at the timeline for the second where it started.
- **delivery p99 climbing while ack p99 stays flat** points at the fanout
  (coordinator → shards), not at the inbound pipeline.
- **connections failed** on a local run is usually the dev server still booting;
  give `--ramp` a few more seconds.
- **`still handshaking` sockets left at the end** means `wrangler dev` (one
  workerd process on your laptop) is saturated, not that the design is. Past
  roughly 50 sockets plus 1k fanout frames/s the local rig is the bottleneck —
  spread the run with a longer `--ramp` or trade viewers for talkers.

## Teto do ambiente local (medido)

O gargalo local é o proxy do `wrangler dev`, não o Worker. Nesta máquina:

| sockets | frames/s | ack p50 | resultado |
|---|---|---|---|
| 25 | ~200 | 23 ms | limpo |
| 40 | ~560 | 1.7 s | conecta tudo, mas a latência vira segundos |
| 50 | ~300 | 1.4 s | começa a perder handshakes |
| 100+ | — | — | o proxy morre com `Network connection lost` |

O log do wrangler mostra `Error in ProxyController: Error inside ProxyWorker`
sem nenhum erro do lado do Worker — não há limite de subrequest, memória ou
exceção da aplicação envolvidos. Para números acima disso, aponte o `--url`
para um deploy real (`wrangler deploy` e `wss://<worker>.workers.dev`).

Use a faixa de até ~25 sockets para comparar mudanças de código: é onde a
medição reflete o Worker e não a ferramenta.
