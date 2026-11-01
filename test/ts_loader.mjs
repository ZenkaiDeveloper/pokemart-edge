/**
 * Resolve extensionless relative imports to .ts for Node --experimental-strip-types.
 * Wrangler resolves these natively; tests need this hook.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register("./ts_hooks.mjs", pathToFileURL(fileURLToPath(import.meta.url)));
