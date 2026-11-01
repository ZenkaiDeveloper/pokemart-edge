import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  ) {
    if (!specifier.endsWith(".ts") && !specifier.endsWith(".js") && !specifier.endsWith(".mjs")) {
      const parent = context.parentURL
        ? fileURLToPath(context.parentURL)
        : null;
      if (parent) {
        const base = join(dirname(parent), specifier);
        if (existsSync(base + ".ts")) {
          return nextResolve(pathToFileURL(base + ".ts").href, context);
        }
        if (existsSync(join(base, "index.ts"))) {
          return nextResolve(pathToFileURL(join(base, "index.ts")).href, context);
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
