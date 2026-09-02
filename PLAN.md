# Live Chat na Cloudflare — Plano de Implementação (v1)

> Stack: **TypeScript** em Workers + Durable Objects + KV + D1 + Queues + Cron.
> Arquitetura de código: **vertical slice architecture**.
> Meta desta primeira versão: **rodar o máximo possível 100% local** (`wrangler dev`
> + `vitest` com o runtime real do workerd via `@cloudflare/vitest-pool-workers`).

---

## 1. Por que TypeScript

A classe do Durable Object — hibernação de WebSocket, `state.storage`, bindings de
KV/D1/Queues — só é exposta nativamente em JS/TS no runtime dos Workers. Go via
TinyGo/WASM viraria só um "motor" chamado de um shim em TS: a parte que importa
(hibernation, storage transacional, fanout) continuaria em TS. Menos maturidade de
tooling, mais complexidade de build, zero ganho. **TypeScript é o caminho de menor
atrito neste produto específico.**

## 2. Arquitetura realtime — dois papéis

Um único Durable Object **não** aguenta 300k WebSockets. A camada realtime é
dividida:

```
                     ┌──────────────────────────────────────────┐
   browser ──WS──►   │  Worker de borda (auth, ban, rate, hash) │
                     └───────────────┬──────────────────────────┘
                                     │ upgrade roteado por hash(user)
                     ┌───────────────▼──────────────┐
                     │  ChatShard  #0 … #N           │  ~5–10k sockets cada
                     │  (hibernação + pipeline)      │  (~30–60 shards p/ 300k)
                     └───────────────┬──────────────┘
                        publish(msg) │ 1 chamada
                     ┌───────────────▼──────────────┐
                     │  RoomCoordinator (1 por sala)│  config + registro de shards
                     └───────────────┬──────────────┘
                     fanout(events)  │ 1 chamada POR SHARD (não por cliente)
                     ┌───────────────▼──────────────┐
                     │  ChatShard #0 … #N → sockets │  saída é de graça
                     └──────────────────────────────┘
```

**É isso que faz o "outgoing messages são de graça" valer a pena:** cada shard paga
por 1 mensagem que entra, não por quantos clientes recebem.

- **RoomCoordinator** — cérebro da sala. Dono da `RoomConfig` autoritativa, do
  registro de shards ativos, do fanout, da propagação de ban e de delete
  retroativo. Nunca segura socket de cliente.
- **ChatShard** — fatia de conexões. Aceita sockets já autenticados (hibernation
  API), roda o pipeline de entrada, entrega ao coordinator **uma vez** e faz o
  fanout local.

### Colocação de conexão (shard placement)

O edge **não** paga round-trip de DO por conexão. O coordinator publica
`shardCount` em KV; o Worker lê com `cacheTtl` e faz `fnv1a(roomId:userId) % shardCount`.
Hash por `userId` mantém o usuário no mesmo shard ao reconectar, preservando o
estado quente dos gates (token bucket, slow-mode).

## 3. Pipeline de entrada (o seam da paralelização)

Toda regra é um `MessageGate` (`src/shared/pipeline.ts`). O shard compõe os gates
na ordem definida em `src/features/registry.ts` e a primeira decisão diferente de
`allow` vence — nada é transmitido nem persistido.

```
base-guard → rate-limit → slow-mode → spam → moderation-sync → broadcast → buffer → queue
```

Gates são puros a menos de `ctx.state` (scratch por usuário dentro do shard):
sem I/O, sem round-trip, testáveis sem Durable Object.

## 4. Plano por funcionalidade

| Funcionalidade | Onde roda | Como |
|---|---|---|
| **Authz** | Worker de borda | Valida JWT (HS256 local / RS256+JWKS em prod) contra a chave, resolve `user_id`, só então decide o shard. O DO recebe a conexão **pré-autenticada** — não gasta CPU de DO (a parte cara do billing) com o que a borda resolve barato. |
| **Ban-check** | KV (quente) + D1 (verdade) | Lista quente em Workers KV lida na borda com cache no connect e revalidada periodicamente; fonte de verdade em D1. Ban aplicado **depois** do connect propaga via evento do coordinator → shards derrubam a conexão daquele usuário. |
| **Rate-limit** | borda + shard | Regra grosseira por IP na borda (binding nativo de Rate Limiting, com fallback KV local) contra flood de conexão; token bucket fino por usuário **dentro do shard**, porque precisa de estado local de "última mensagem" sem round-trip. |
| **Slow-mode** | config no coordinator, aplicação no shard | `slowModeMs` é config global da live, vive no coordinator e é replicado aos shards. A rejeição acontece no shard, reaproveitando o mesmo `UserGateState` do rate-limit. |
| **Spam** | shard, inline | Duplicata em sequência, velocidade anormal (burst), excesso de links/menções, caps. Barato: já está no caminho do rate-limit, é só mais uma checagem antes de propagar. |
| **Moderação síncrona** | shard, inline | Wordlist/regex antes do broadcast — bloqueia ou mascara na hora, sem round-trip. |
| **Moderação assíncrona** | Queues + Worker consumer | Mensagens vão para `chat-moderation`; o consumer roda heurísticas/IA mais pesadas e emite **delete retroativo** que o coordinator propaga aos shards e os clientes aplicam. |
| **Persistência** | buffer no shard → Queues → D1 | O shard **não** escreve no banco por mensagem. Acumula buffer em memória e manda em lote para `chat-persist`, que grava em D1 em batches. Trade-off consciente: não é persistência instantânea, mas evita transformar cada mensagem numa escrita síncrona. |
| **Ranking** | Cron Trigger + KV | Não é calculado por mensagem. Um Worker com cron lê o acumulado de D1, recalcula (mais ativos, mais reagidos) e escreve o resultado pronto em KV; o frontend só lê. Desacopla o cálculo pesado do caminho quente. |
| **Broadcast** | Worker → coordinator → shards | O fluxo central, e só acontece depois que a mensagem passou por todas as checagens acima. |

> **Nota sobre o cron:** o menor intervalo de Cron Trigger da Cloudflare é 1 minuto.
> Para a janela de 10–30s citada no plano original, o refresh fino é disparado pelo
> **alarm do coordinator**; o cron de 1 minuto continua como recompute durável.

## 5. Estrutura vertical slice

```
src/
├── worker.ts                 # única entrada pública (fetch / queue / scheduled)
├── env.ts                    # bindings tipados
├── shared/                   # kernel compartilhado — contratos, sem regra de negócio
│   ├── protocol.ts           # wire protocol cliente↔shard e coordinator↔shard
│   ├── pipeline.ts           # MessageGate, GateContext, UserGateState, runPipeline
│   ├── ports.ts              # CoordinatorApi, ShardApi, BanStore, MessageBuffer…
│   ├── room-config.ts        # RoomConfig autoritativa + defaults + merge
│   ├── identity.ts           # Identity + ConnectMetadata (borda → shard)
│   ├── http.ts               # Router minimalista + helpers
│   └── ids.ts / hash.ts / time.ts / errors.ts / logger.ts / result.ts / slice.ts
├── features/                 # UMA PASTA POR SLICE (rotas + domínio + testes)
│   ├── registry.ts           # composition root: a única coisa que conhece todos
│   ├── auth/ ban/ rate-limit/ slow-mode/ spam/
│   ├── moderation/ persistence/ ranking/
│   ├── routing/ room/ connect/
└── realtime/
    ├── coordinator.ts        # RoomCoordinator DO
    └── shard.ts              # ChatShard DO
```

Regra de dependência: um slice pode importar `src/shared/*` e o `index.ts` público
de outro slice. Nunca arquivos internos de outro slice.

## 6. Etapas (sem conflito entre si)

**Etapa 0 — Fundação (concluída antes de paralelizar).**
Scaffold, tsconfig, `wrangler.jsonc` com todos os bindings, migrations D1, kernel
compartilhado com todos os contratos congelados, `registry.ts`, esqueleto funcional
dos dois Durable Objects, harness de teste no runtime real e teste e2e de broadcast
verde. É o que torna as etapas seguintes independentes.

**Etapa 1 — slices paralelos.** Cada item abaixo é uma tarefa isolada, com dono
único de diretório e zero sobreposição de arquivos:

| # | Slice | Diretório exclusivo |
|---|---|---|
| 1 | Auth (JWT HS256 + RS256/JWKS, tokens de dev) | `src/features/auth/` |
| 2 | Ban (KV quente + D1 verdade + propagação) | `src/features/ban/` |
| 3 | Rate-limit (token bucket + limiter de borda) | `src/features/rate-limit/` |
| 4 | Slow-mode + Spam heurístico | `src/features/slow-mode/`, `src/features/spam/` |
| 5 | Moderação síncrona + fila assíncrona + delete retroativo | `src/features/moderation/` |
| 6 | Persistência em lote (buffer → Queues → D1) + histórico | `src/features/persistence/` |
| 7 | Ranking (cron + D1 → KV + API de leitura) | `src/features/ranking/` |
| 8 | ChatShard: hibernação, presença, backpressure, stats | `src/realtime/shard*` |
| 9 | RoomCoordinator: registro, fanout, escala de shards | `src/realtime/coordinator*` |
| 10 | Cliente de demonstração + ferramenta de carga | `public/`, `tools/` |

**Etapa 2 — integração.** Merge das branches, typecheck, suíte completa, teste de
carga local simulando picos de 10–50 msg/s e ensaio de `wrangler dev` fim a fim.

## 7. Simulação local — o que dá para rodar sem nuvem

| Componente | Local? | Como |
|---|---|---|
| Worker de borda | ✅ | `npm run dev` (workerd real) |
| Durable Objects + hibernação | ✅ | `wrangler dev` / `vitest-pool-workers` |
| KV | ✅ | estado local em `.wrangler/state` |
| D1 | ✅ | `npm run db:migrate:local` |
| Queues (produtor + consumidor) | ✅ | consumidores locais no mesmo `wrangler dev` |
| Cron Trigger | ✅ | `curl "localhost:8787/cdn-cgi/handler/scheduled"` |
| Rate Limiting nativo da CF | ⚠️ | binding só em produção; fallback KV local |
| Teste de carga | ✅ | `npm run loadtest` (N sockets contra o dev local) |

## 8. Comandos

```bash
npm install
npm run db:migrate:local     # cria o schema D1 local
npm run dev                  # wrangler dev em http://127.0.0.1:8787
npm run check                # typecheck + suíte de testes no runtime real
npm run loadtest             # picos de conexão/mensagem contra o dev local
```
