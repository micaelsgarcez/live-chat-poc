// Creates .dev.vars from .dev.vars.example on first run so a fresh checkout can
// run `npm run dev` / `npm test` without any manual setup.
import { copyFileSync, existsSync } from "node:fs";

if (!existsSync(".dev.vars") && existsSync(".dev.vars.example")) {
  copyFileSync(".dev.vars.example", ".dev.vars");
  console.log("created .dev.vars from .dev.vars.example");
}
