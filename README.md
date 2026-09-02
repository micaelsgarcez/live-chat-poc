# live-chat-cloudflare

Chat ao vivo para picos de centenas de milhares de espectadores, inteiro na
Cloudflare: Workers na borda, Durable Objects para o realtime, KV para leitura
quente, D1 para a verdade, Queues para o que sai do caminho crítico e Cron para
o que não precisa ser em tempo real.

TypeScript, **vertical slice architecture**, e tudo roda **100% local** — sem
conta Cloudflare, sem deploy.

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
npm run check          # typecheck + 250 testes no runtime real do workerd
node tools/seed/seed.mjs --room demo --users 6 --messages 40
npm run loadtest -- --clients 25 --talkers 8 --rate 12 --duration 20
```

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

## Endpoints

| Método | Rota | O quê |
|---|---|---|
| GET | `/ws/:roomId?token=` | upgrade de WebSocket (atalho da demo) |
| GET | `/api/rooms/:roomId/connect` | o mesmo upgrade, nome canônico |
| POST | `/api/dev/token` | token HS256 local (bloqueado em produção) |
| GET | `/api/me` | identidade do token apresentado |
| GET/PATCH | `/api/rooms/:roomId/config` | configuração da sala (PATCH = moderador) |
| GET | `/api/rooms/:roomId/stats` | shards registrados, presença, contadores |
| GET | `/api/rooms/:roomId/messages` | histórico paginado (`limit`, `before`), com a citação da resposta |
| GET | `/api/rooms/:roomId/ranking` | ranking pronto do KV (`?refresh=1` recalcula) |
| GET/POST | `/api/rooms/:roomId/bans` | listar / aplicar ban (moderador) |
| DELETE | `/api/rooms/:roomId/bans/:userId` | remover ban |
| POST | `/api/rooms/:roomId/moderation/delete` | delete retroativo |
| POST | `/api/rooms/:roomId/moderation/mute` | silenciar usuário |
| GET | `/api/rooms/:roomId/moderation/actions` | auditoria |

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

## Números medidos localmente

`wrangler dev` + 25 sockets, 8 remetentes, 12 msg/s numa sala com 4 shards:

| | p50 | p95 | p99 |
|---|---|---|---|
| handshake | 40 ms | 99 ms | 178 ms |
| ack | 23 ms | 31 ms | 37 ms |
| entrega fim a fim | 12 ms | 17 ms | 27 ms |

5.024 frames entregues, ~200 frames/s, zero conexões perdidas. As rejeições que
aparecem são o token bucket funcionando: 8 remetentes a 1,5 msg/s contra uma
capacidade de 5 e recarga de 1/s.

**Teto local:** o proxy do `wrangler dev` (não o Worker) satura em torno de
400–500 frames/s; acima de ~40 sockets a latência sobe para segundos e acima de
~66 ele derruba a conexão com `Network connection lost`. Isso é limitação da
ferramenta de desenvolvimento, não da arquitetura — os números de escala real
dependem de um deploy. Veja `tools/loadtest/README.md`.
