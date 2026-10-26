import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function verifyRelease(bytes, root = process.cwd()) {
  const files = unzipSync(bytes);
  if (!files.SHA256SUMS || !files["RELEASE.json"])
    throw Error("RELEASE_MANIFEST_MISSING");
  const manifest = new Map();
  for (const line of Buffer.from(files.SHA256SUMS)
    .toString("utf8")
    .trim()
    .split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || manifest.has(match[2]))
      throw Error("RELEASE_MANIFEST_INVALID");
    manifest.set(match[2], match[1]);
  }
  if (manifest.size !== Object.keys(files).length - 1)
    throw Error("RELEASE_MANIFEST_COVERAGE");
  for (const [path, expected] of manifest) {
    if (
      /\\|\x00/.test(path) ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    )
      throw Error("RELEASE_UNSAFE_PATH");
    const entry = files[path];
    if (!entry || sha256(entry) !== expected)
      throw Error("RELEASE_ENTRY_DIGEST_MISMATCH");
    if (path === "RELEASE.json") continue;
    if (
      !/^(source|results)\//.test(path) ||
      /(?:^|\/)(?:data|node_modules|\.git)(?:\/|$)|\.(?:pem|key|sqlite|vhdx)$/.test(
        path,
      ) ||
      path.startsWith("source/deploy/runtime/") ||
      path === "source/.env"
    )
      throw Error("RELEASE_RUNTIME_FILE");
    const original = path.startsWith("source/")
      ? resolve(root, path.slice(7))
      : resolve(
          process.env.DATA_DIR ?? resolve(root, "data/app"),
          "results",
          path.slice(8),
        );
    if (!existsSync(original) || sha256(readFileSync(original)) !== expected)
      throw Error(`RELEASE_WORKSPACE_MISMATCH:${path}`);
  }
  return {
    date: new Date().toISOString(),
    passed: true,
    files: Object.keys(files).length,
    bytes: bytes.length,
    sha256: sha256(bytes),
    source: JSON.parse(Buffer.from(files["RELEASE.json"]).toString("utf8"))
      .source,
    checks: [
      "all internal file hashes match",
      "all included source, compiled files and selected evidence match workspace bytes",
      "runtime data, private keys and dependencies excluded",
    ],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const bytes = readFileSync("release/ContentProof.zip");
  const expected = readFileSync("release/SHA256SUMS", "utf8").trim();
  if (expected !== `${sha256(bytes)}  ContentProof.zip`)
    throw Error("RELEASE_ARCHIVE_DIGEST_MISMATCH");
  const report = verifyRelease(bytes);
  report.checks.unshift("archive SHA256 matches external checksum");
  writeFileSync("release/verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
