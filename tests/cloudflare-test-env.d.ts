// Makes `env` from `cloudflare:test` resolve to this Worker's bindings.
type WorkerBindings = import("../src/env").Env;

declare namespace Cloudflare {
  interface Env extends WorkerBindings {}
}
