import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const manifestName = "snapshot-manifest.json";
function inventory(
  root: string,
  prefix = "",
  files: Record<string, string> = {},
) {
  for (const entry of readdirSync(resolve(root, prefix), {
    withFileTypes: true,
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = prefix + entry.name;
    if (!prefix && ["data", manifestName].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw Error("SNAPSHOT_LINK_NOT_FROZEN");
    if (entry.isDirectory()) inventory(root, name + "/", files);
    else if (entry.isFile())
      files[name] = sha(readFileSync(resolve(root, name)));
    else throw Error("SNAPSHOT_UNSUPPORTED_FILE");
  }
  return files;
}
export function writeSnapshotManifest(root: string) {
  const files = inventory(root),
    treeSha256 = sha(JSON.stringify(files));
  const manifest = {
    version: 1,
    date: new Date().toISOString(),
    node: process.version,
    runtimeSha256: sha(readFileSync(process.execPath)),
    dependencyScope: "Fully copied dependencies; no shared node_modules",
    treeSha256,
    files,
  };
  writeFileSync(
    resolve(root, manifestName),
    JSON.stringify(manifest, null, 2),
    { flag: "wx" },
  );
  return treeSha256;
}
export function verifySnapshotManifest(root: string) {
  const manifest = JSON.parse(
    readFileSync(resolve(root, manifestName), "utf8"),
  );
  if (
    manifest.version !== 1 ||
    manifest.node !== process.version ||
    manifest.runtimeSha256 !== sha(readFileSync(process.execPath))
  )
    throw Error("SNAPSHOT_RUNTIME_CHANGED");
  const actual = inventory(root),
    digest = sha(JSON.stringify(actual));
  if (
    digest !== manifest.treeSha256 ||
    JSON.stringify(actual) !== JSON.stringify(manifest.files)
  )
    throw Error("SNAPSHOT_FILES_CHANGED");
  return digest;
}
