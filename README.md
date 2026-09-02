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

## Números medidos localmente

`wrangler dev` numa sala com 4 shards, 12 msg/s, um quarto dos clientes falando.
Todos abriram 100 % dos sockets pedidos, com zero handshake perdido e zero
mensagem confirmada e não entregue:

| sockets | entregues/s | ack p50 | ack p99 | entrega p99 | veredito |
|---:|---:|---:|---:|---:|---|
| 25 | 164 | 25 ms | 87 ms | 72 ms | PASS |
| 50 | 348 | 32 ms | 103 ms | 94 ms | PASS |
| 100 | 666 | 27 ms | 69 ms | 60 ms | PASS |
| 200 | 1.302 | 701 ms | 1.457 ms | 1.250 ms | FAIL |

E o efeito de ligar coalescência e amostragem, com o mesmo carregamento
oferecido (20 sockets, 10 remetentes, 20 msg/s):

| | desligado | ligado |
|---|---:|---:|
| ack p99 | 580 ms | **75 ms** |
| entrega p99 | 551 ms | **169 ms** |
| frames de WebSocket | 7.392 | **2.658** |
| chamadas de DO no fanout | 1.604 | **1.168** |
| veredito | FAIL | **PASS** |

**Teto local:** o proxy do `wrangler dev` (não o Worker) cede por *frames por
segundo*, não por sockets — limpo até ~700, degradado em ~1.300, e acima disso o
processo morre com um `ERROR` vazio do ProxyController, sem nenhum erro do lado
do Worker. Isso é limitação da ferramenta de desenvolvimento, não da
arquitetura; os números de escala real dependem de um deploy e de uma frota de
máquinas de carga. Veja [`docs/LOADTEST.md`](docs/LOADTEST.md).
