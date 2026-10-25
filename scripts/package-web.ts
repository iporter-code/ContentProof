import {
  readdirSync,
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import {
  assertPublicReleaseFile,
  assertNoConfiguredSecret,
} from "./release-safety.js";
const root = resolve("dist/web"),
  entries: Record<string, Uint8Array> = {};
function collect(relative = "") {
  for (const name of readdirSync(resolve(root, relative)).sort()) {
    const rel = relative + name,
      path = resolve(root, rel),
      stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !/^\w[\w./-]*$/.test(rel) ||
      rel.split("/").some((p) => p.startsWith("."))
    )
      throw Error("UNSAFE_WEB_RELEASE_PATH");
    if (stat.isDirectory()) {
      collect(rel + "/");
      continue;
    }
    if (
      !stat.isFile() ||
      !(
        rel === "index.html" ||
        (rel.startsWith("assets/") &&
          /\.(?:js|css|svg|png|jpg|jpeg|webp|ico|woff2?|ttf)$/.test(rel))
      )
    )
      throw Error("UNEXPECTED_WEB_RELEASE_FILE");
    assertPublicReleaseFile(path);
    const bytes = readFileSync(path);
    if (/\.(?:html|js|css|json|svg)$/.test(rel))
      assertNoConfiguredSecret(bytes.toString("utf8"));
    entries["web/" + rel] = bytes;
  }
}
collect();
if (!entries["web/index.html"] || Object.keys(entries).length > 256)
  throw Error("WEB_BUILD_REQUIRED");
const bytes = zipSync(entries, { level: 6 }),
  hash = createHash("sha256").update(bytes).digest("hex");
mkdirSync("data/web-delivery", { recursive: true });
writeFileSync("data/web-delivery/web.zip", bytes);
writeFileSync("data/web-delivery/web.sha256", hash);
console.log(
  JSON.stringify({
    sha256: hash,
    files: Object.keys(entries).length,
    bytes: bytes.length,
    scope:
      "Public compiled web files only; no backend, credentials or business data.",
  }),
);
