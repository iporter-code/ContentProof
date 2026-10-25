import { createRequire } from "node:module";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  readdirSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const require = createRequire("/validation/package.json"),
  { unzipSync } = require("fflate");
const out = "/delivery/contentproof";
mkdirSync(out, { recursive: true });
for (const [n, b] of Object.entries(
  unzipSync(readFileSync("/tmp/source.zip")),
)) {
  const p = resolve(out, n);
  if (!p.startsWith(out + "/app/") || n.includes(".."))
    throw Error("UNSAFE_SOURCE");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, b);
}
const prune = spawnSync(
  "npm",
  [
    "prune",
    "--omit=dev",
    "--ignore-scripts",
    "--offline",
    "--no-audit",
    "--no-fund",
  ],
  { cwd: "/validation", stdio: "inherit" },
);
if (prune.status !== 0) throw Error("PROD_DEPENDENCIES_FAILED");
cpSync("/validation/node_modules", out + "/app/node_modules", {
  recursive: true,
  verbatimSymlinks: true,
});
mkdirSync(out + "/runtime/bin", { recursive: true });
cpSync("/usr/local/bin/node", out + "/runtime/bin/node");
chmodSync(out + "/runtime/bin/node", 0o755);
mkdirSync(out + "/native/c2pa/binary/c2patool", { recursive: true });
const t = spawnSync(
  "tar",
  [
    "-xzf",
    "/tmp/c2patool.tar.gz",
    "-C",
    out + "/native/c2pa/binary",
    "c2patool/c2patool",
  ],
  { stdio: "inherit" },
);
if (t.status !== 0) throw Error("NATIVE_EXTRACTION_FAILED");
const pins = JSON.parse(
    readFileSync(out + "/app/configs/native-tools.json"),
  ).c2patool,
  pin = pins["linux-x64"],
  hash = (b) => createHash("sha256").update(b).digest("hex");
if (
  hash(readFileSync("/tmp/c2patool.tar.gz")) !== pin.sha256 ||
  hash(readFileSync(out + "/native/c2pa/binary/c2patool/c2patool")) !==
    pin.binarySha256
)
  throw Error("C2PA_HASH_MISMATCH");
writeFileSync(
  out + "/native/c2pa/provenance.json",
  JSON.stringify({
    version: pins.version,
    source: pin.url,
    archiveSha256: pin.sha256,
    commit: pins.commit,
    binary: "binary/c2patool/c2patool",
    binarySha256: pin.binarySha256,
  }),
);
const files = {};
function walk(dir, rel = "") {
  for (const n of readdirSync(dir)) {
    const p = dir + "/" + n,
      r = rel + n,
      s = lstatSync(p);
    if (s.isDirectory()) walk(p, r + "/");
    else if (s.isFile()) files[r] = hash(readFileSync(p));
  }
}
walk(out);
writeFileSync(out + "/FILE_HASHES.json", JSON.stringify(files));
writeFileSync(
  out + "/PROVENANCE.json",
  JSON.stringify({
    date: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    productionDependencies: true,
    sourceSha256: hash(readFileSync("/tmp/source.zip")),
    nativeVersion: pins.version,
    nativeSha256: pin.binarySha256,
    files: Object.keys(files).length,
  }),
);
const tar = spawnSync(
  "tar",
  ["-czf", "/tmp/contentproof-cloud.tar.gz", "-C", "/delivery", "contentproof"],
  { stdio: "inherit" },
);
if (tar.status !== 0) throw Error("ARCHIVE_FAILED");
console.log("Linux cloud runtime packaged.");
