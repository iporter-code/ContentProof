// Opt-in synthetic integration instrumentation. Logs module paths only.
const Module = require("node:module");
const { appendFileSync, mkdirSync } = require("node:fs");
const { resolve } = require("node:path");
if (process.env.CP_DEP_TRACE_DIR) {
  const dir = resolve(process.env.CP_DEP_TRACE_DIR);
  mkdirSync(dir, { recursive: true });
  const seen = new Set();
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    const value = Reflect.apply(original, this, arguments);
    try {
      const path = Module._resolveFilename(request, parent, isMain);
      if (
        typeof path === "string" &&
        path.includes("node_modules") &&
        !seen.has(path)
      ) {
        seen.add(path);
        appendFileSync(
          resolve(dir, `${process.pid}.jsonl`),
          JSON.stringify({ path }) + "\n",
        );
      }
    } catch {}
    return value;
  };
}
