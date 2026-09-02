# live-chat-cloudflare — working agreement

Cloudflare Workers + Durable Objects live chat, TypeScript, **vertical slice
architecture**. Read `PLAN.md` for the architecture before changing anything.

## Non-negotiables

1. **Stay inside your slice.** Every task in this repo owns an exclusive set of
   directories. Do not create, edit, delete or reformat files outside them. If
   you believe a shared file must change, stop and say so in your final report —
   do not change it.
2. **Never change a frozen contract.** These files are the seams that let slices
   be built in parallel and are owned by the integrator:
   - `src/shared/**` (protocol, pipeline, ports, room-config, identity, http, slice)
   - `src/env.ts`, `src/worker.ts`, `src/features/registry.ts`
   - `wrangler.jsonc`, `tsconfig.json`, `vitest.config.ts`, `package.json`, `migrations/**`
   You may *read* them freely and you must implement exactly the signatures they
   declare. Adding a new npm dependency is not allowed.
3. **Keep the exported surface of your slice's `index.ts` exactly as documented
   in its header comment.** Other slices and the registry import it by name.
4. `npm run check` (typecheck + tests) must pass before you are done.

## Layout

```
src/shared/      contracts only, no business rules
src/features/<slice>/   routes + domain + tests for one capability
src/realtime/    the two Durable Objects
tests/           cross-slice integration tests (+ tests/helpers/client.ts)
tools/           demo client tooling and the local load generator
```

Import rule: a slice may import from `src/shared/*` and from another slice's
`index.ts`. Never from another slice's internal files.

## The pipeline

Every inbound rule is a `MessageGate` (`src/shared/pipeline.ts`). Gates are pure
except for `ctx.state` (`UserGateState`, per user, in shard memory). No I/O in a
gate. Order lives in `src/features/registry.ts`:

```
base-guard → rate-limit → slow-mode → spam → moderation-sync
```

`UserGateState` has one named field per concern. Only touch the fields your slice
owns (documented inline in `pipeline.ts`).

## Commands

```bash
npm install
npm run db:migrate:local     # D1 schema into .wrangler/state
npm run dev                  # wrangler dev on 127.0.0.1:8787
npm run typecheck
npm run test                 # vitest inside the real workerd runtime
npm run check                # both
```

Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers`:
`import { env, SELF, runInDurableObject } from "cloudflare:test"`.
`tests/helpers/client.ts` has a buffering WebSocket `TestClient` — use it instead
of writing another one.

Put unit tests next to the code (`src/features/<slice>/*.test.ts`). Only put a
test in `tests/` if it genuinely spans slices.

## Style

- Match the surrounding code: explicit types on exported functions, no default
  exports except `src/worker.ts`, comments that explain *why*, not *what*.
- No `any` in new code; no new dependencies; no console.log — use
  `createLogger` from `src/shared/logger.ts`.
- Local-first: everything must work with no Cloudflare account. If a feature has
  a production-only binding (e.g. native Rate Limiting), feature-detect it and
  fall back to a local implementation.
