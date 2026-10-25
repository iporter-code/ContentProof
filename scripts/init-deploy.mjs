import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
mkdirSync("deploy/runtime", { recursive: true });
const path = "deploy/runtime/storage.key";
if (!existsSync(path))
  writeFileSync(path, randomBytes(32).toString("hex"), {
    flag: "wx",
    mode: 0o600,
  });
console.log(
  "Deployment secret initialized. Existing secret is preserved; never publish deploy/runtime.",
);
