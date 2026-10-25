import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import {
  assertPublicReleaseFile,
  assertNoConfiguredSecret,
} from "./release-safety.js";
const entries: Record<string, Uint8Array> = {};
function collect(path: string) {
  if (!existsSync(path)) return;
  const rel = relative(process.cwd(), resolve(path)).split(sep).join("/");
  if (rel === "deploy/runtime" || rel.startsWith("deploy/runtime/")) return;
  assertPublicReleaseFile(path);
  if (statSync(path).isDirectory()) {
    for (const n of readdirSync(path)) collect(path + "/" + n);
    return;
  }
  if (
    /(?:^|\/)(?:data|node_modules|\.git)(?:\/|$)|\.(?:pem|key|sqlite|vhdx)$/.test(
      rel,
    )
  )
    throw Error("CLOUD_SOURCE_CONTAINS_RUNTIME_FILE");
  const bytes = readFileSync(path);
  if (
    /\.(?:ts|tsx|js|mjs|md|json|css|html|sh|service|timer|conf|yml)$/.test(rel)
  )
    assertNoConfiguredSecret(bytes.toString("utf8"));
  entries["app/" + rel] = bytes;
}
for (const p of [
  "apps",
  "packages",
  "scripts",
  "configs",
  "docs",
  "deploy",
  "dist/server",
  "dist/web",
  "package.json",
  "package-lock.json",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
])
  collect(p);
if (
  !entries["app/dist/server/apps/api/main.js"] ||
  !entries["app/dist/web/index.html"]
)
  throw Error("BUILD_FIRST");
const bytes = zipSync(entries, { level: 6 });
mkdirSync("data/cloud-delivery", { recursive: true });
writeFileSync("data/cloud-delivery/source.zip", bytes);
writeFileSync(
  "data/cloud-delivery/source.sha256",
  createHash("sha256").update(bytes).digest("hex"),
);
console.log(
  `Cloud source prepared: ${Object.keys(entries).length} public files; local runtime data excluded.`,
);
