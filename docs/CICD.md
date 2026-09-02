# CI/CD

Dois workflows do GitHub Actions:

| Workflow | Quando | O que faz |
|---|---|---|
| `.github/workflows/ci.yml` | toda PR, todo push na `main` | typecheck, suíte completa no workerd com relatório **por funcionalidade**, build do Worker e smoke funcional contra um `wrangler dev` real |
| `.github/workflows/deploy.yml` | push na `main` (ou manual) | roda o CI inteiro, aplica as migrations no D1 remoto, publica na Cloudflare, grava os secrets e **verifica a URL publicada** |

Nada do CI precisa de conta na Cloudflare. Só o deploy precisa.

---

## CI — validação por funcionalidade

O job **`validate`** roda `npm run typecheck` e a suíte com o reporter JSON, e
`tools/ci/summarize-tests.mjs` agrupa o resultado pela fatia vertical a que cada
arquivo de teste pertence. O resumo do job responde a pergunta que importa
quando o build fica vermelho — *qual capacidade quebrou* — em vez de só contar
testes:

```
| Funcionalidade                                   | Testes | Passou | Falhou |
|--------------------------------------------------|-------:|-------:|-------:|
| ✅ Autenticação (JWT, tokens de dev)              |     32 |     32 |      0 |
| ❌ Moderação (síncrona + fila + delete retroativo)|     41 |     39 |      2 |
| …                                                 |        |        |        |
```

O job **`build`** compila o bundle com `wrangler deploy --dry-run` — o que valida
`wrangler.jsonc` e todos os bindings — e depois faz o mesmo com a config de
produção gerada, para que um erro no gerador apareça na PR e não no deploy.

O job **`smoke`** (`tools/ci/smoke.mjs`) sobe um `wrangler dev` de verdade e
percorre o produto como o cliente da demo faz: `/health`, o cliente estático
servido pelo binding `ASSETS`, token de dev, `/api/me`, config e histórico da
sala, seis WebSockets abertos pelo gerador de carga com ack e fanout medidos,
recompute do ranking (D1 → KV) e as estatísticas do coordinator. É a parte que
os testes unitários não cobrem: o processo, o arquivo de configuração e o
upgrade de WebSocket de ponta a ponta.

Rodando na sua máquina:

```bash
npm run check                  # o mesmo que o job validate
node tools/ci/smoke.mjs        # o mesmo que o job smoke (usa a porta 8788)
```

---

## CD — deploy na Cloudflare

### Por que a config de deploy é gerada

`wrangler.jsonc` é um **contrato congelado** (veja `CLAUDE.md`) e descreve o
mundo local: ids de recurso de mentira e `ENVIRONMENT=local`. Um deploy real
precisa dos ids de uma conta específica, e esses ids são configuração do
pipeline, não do repositório.

Em vez de duplicar o arquivo — e deixar as duas cópias divergirem no próximo
binding, fila ou migration de Durable Object — o deploy **gera**
`wrangler.deploy.json` a partir do `wrangler.jsonc`, injetando o que é da conta:

```bash
node tools/ci/render-wrangler-config.mjs                 # usa o ambiente
node tools/ci/render-wrangler-config.mjs --placeholders   # ids falsos, para validar
```

Uma única fonte da verdade para a forma do Worker; o arquivo congelado não é
tocado, e nenhum id de conta entra no git.

O gerador ainda liga em produção o binding nativo de **Rate Limiting**
(`EDGE_RATE_LIMITER`, 60 conexões/minuto — o mesmo número de
`EDGE_CONNECTIONS_PER_MINUTE`), que não existe localmente: lá a fatia
`rate-limit` cai para o contador em KV.

### O modo do deploy: demonstração pública

O deploy sai como **`ENVIRONMENT=demo`**, não `production`, e isso é uma decisão,
não um descuido.

O Worker desliga `POST /api/dev/token` exatamente quando `ENVIRONMENT` é
`"production"`. Essa é a única rota que emite token, e é dela que o cliente da
demo (`public/app.js`) tira o seu — sem ela a página abre e não conecta. Como o
objetivo aqui é uma URL pública onde dê para **usar** o chat e ver as regras
funcionando, a rota fica ligada.

A consequência é explícita: o corpo da requisição escolhe os `roles`, então
qualquer visitante pode se declarar moderador e experimentar apagar, silenciar e
banir. Numa demonstração isso é a funcionalidade — as regras (rate limit, slow
mode, spam, moderação síncrona, ban) só se mostram para quem consegue tentar
quebrá-las. Num produto de verdade seria uma falha grave, e é por isso que o
Worker já traz o interruptor pronto.

Tudo o mais é idêntico à produção: mesmos gates na mesma ordem, mesma sala
`demo` fixa, mesmas filas, mesmo cron, mesmo D1. O que muda é só quem pode
emitir um token.

Para fechar quando existir um emissor de verdade:

```bash
gh variable set CF_ENVIRONMENT --body 'production'
gh variable set JWT_ISSUER     --body 'https://<seu emissor>'
gh variable set JWT_ALG        --body 'RS256'      # se for JWKS
gh variable set JWKS_URL       --body 'https://<seu emissor>/.well-known/jwks.json'
```

A verificação pós-deploy acompanha a escolha: em modo demo ela exige que
`/api/dev/token` **funcione** e devolva um token com papel de moderador; em
`production` ela exige que a rota devolva **404**.

### Pré-requisitos

- Uma conta Cloudflare no plano **Workers Paid** — Queues (`chat-persist`,
  `chat-moderation`, `chat-dlq`) não existe no plano gratuito, e o Worker
  depende delas para persistência e moderação assíncrona.
- Um API token com permissão de editar Workers, D1, KV e Queues.

### 1. Provisionar os recursos

```bash
export CLOUDFLARE_API_TOKEN=...    # ou: npx wrangler login
export CLOUDFLARE_ACCOUNT_ID=...
node tools/ci/provision.mjs
```

O script é idempotente: cria o banco D1, o namespace KV e as três filas se
faltarem, e no fim imprime os comandos `gh` já preenchidos com os ids.

### 2. Configurar o repositório

**Secrets** (`gh secret set NOME`):

| Secret | Para quê |
|---|---|
| `CLOUDFLARE_API_TOKEN` | autenticar o `wrangler` |
| `CLOUDFLARE_ACCOUNT_ID` | a conta de destino |
| `JWT_HS256_SECRET` | chave dos tokens HS256 (também usada pela verificação pós-deploy) |
| `MODERATOR_API_KEY` | header `x-moderator-key` das rotas de moderação |

> **`LOADTEST_BYPASS_KEY` não entra nesta tabela de propósito.** Ele permite
> pular o limite de conexões da borda e por isso **não é secret de pipeline**:
> deve ser posto à mão com `wrangler secret put` imediatamente antes de um teste
> de carga e removido com `wrangler secret delete` logo depois. Enquanto ele não
> existe, o bypass não existe — e é assim que a demo pública fica por padrão.
> Veja [`LOADTEST.md`](LOADTEST.md).

**Variables** (`gh variable set NOME --body ...`):

| Variable | Padrão | Para quê |
|---|---|---|
| `CF_KV_ID` | — (obrigatório) | id do namespace KV |
| `CF_D1_DATABASE_ID` | — (obrigatório) | id do banco D1 |
| `CF_D1_DATABASE_NAME` | `live-chat` | nome do banco |
| `CF_ENVIRONMENT` | `demo` | `production` desliga `/api/dev/token` (veja acima) |
| `CF_WORKER_NAME` | `live-chat` | nome do Worker publicado |
| `CF_CUSTOM_DOMAIN` | — | domínio próprio; sem ele fica só a URL `workers.dev` |
| `CF_RATE_LIMIT_NAMESPACE_ID` | `1001` | namespace do rate limiter nativo |
| `JWT_ISSUER` / `JWT_AUDIENCE` / `JWT_ALG` / `JWKS_URL` | os do `wrangler.jsonc` | configuração do emissor de tokens |
| `DEFAULT_SHARD_COUNT` / `MAX_SOCKETS_PER_SHARD` / `LOG_LEVEL` | os do `wrangler.jsonc` | ajuste de escala e log |

> `JWT_ISSUER` sai do `wrangler.jsonc` como `https://auth.local.test`. No modo
> demo é o próprio Worker que assina e verifica, então o valor só precisa ser
> consistente consigo mesmo e pode ficar como está. Com `CF_ENVIRONMENT=production`
> os tokens passam a vir de fora e o placeholder deixa de validar qualquer coisa
> — o gerador avisa nesse caso.

Opcionalmente crie o **environment `production`** no GitHub para exigir
aprovação manual antes do deploy: o job já declara `environment: production`, e
a URL publicada aparece nele.

### 3. Primeiro deploy

Push na `main` — ou **Actions → Deploy → Run workflow**. A ordem dentro do job:

1. **preflight** — falha na hora, listando o que falta, se algum secret ou
   variable obrigatório estiver vazio;
2. **migrations** antes do código (são aditivas, então a versão que ainda está
   no ar continua compatível);
3. `wrangler deploy` com a config gerada;
4. **secrets** gravados no Worker (valem na hora, sem republicar);
5. **verificação** (`tools/ci/verify-deploy.mjs`) na URL publicada: o Worker
   responde, está no modo esperado, o cliente é servido, a porta de entrada de
   token se comporta como o modo pede, e um WebSocket conecta, envia e recebe o
   ack e o fanout de volta pelos Durable Objects reais. Ela repete por até cinco
   tentativas: cada `wrangler secret put` publica uma versão nova, e enquanto o
   rollout acontece uma requisição pode cair na versão anterior.

`concurrency: deploy-production` garante que dois deploys nunca se atropelem.

---

## Rollback

O deploy não é destrutivo, mas o caminho de volta é o do Cloudflare:

```bash
npx wrangler deployments list --config wrangler.deploy.json
npx wrangler rollback [VERSION_ID] --config wrangler.deploy.json
```

Gere a config antes (`node tools/ci/render-wrangler-config.mjs`) para ter o
`wrangler.deploy.json` na mão. Migrations do D1 não voltam sozinhas: como são
aditivas, um rollback de código roda contra o schema novo sem problema.

## O que ficou de fora, de propósito

- **Ambiente de staging / preview por PR.** Exige um segundo conjunto de
  recursos (KV, D1, filas) e dobra o custo. Quando fizer sentido, é o mesmo
  `render-wrangler-config.mjs` com `CF_ENVIRONMENT=staging` e outro conjunto de
  variables.
- **Teste de carga no CI.** O `npm run loadtest` contra um `wrangler dev` mede o
  teto do proxy, não o da arquitetura; rodá-lo a cada push só mediria o runner
  do GitHub. E os presets grandes gastam dinheiro de verdade e precisam do
  bypass do limite de conexões armado — nada disso deve ser disparado por um
  push. Veja [`LOADTEST.md`](LOADTEST.md).

## Subir da sua máquina, sem GitHub Actions

O caminho curto — `wrangler login`, `provision.mjs`, `render-wrangler-config.mjs`,
`deploy` — está no [`README.md`](../README.md#subir-na-cloudflare-em-cinco-minutos).
Ele usa exatamente os mesmos scripts que o workflow usa, então o que funciona lá
funciona aqui; a diferença é só de onde vêm os ids e os secrets.
