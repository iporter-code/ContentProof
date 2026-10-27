import { readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function gitRead(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  return result.status === 0 ? result.stdout : null;
}
function gitWorkspace(root) {
  const top = gitRead(root, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const fold = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (fold(realpathSync(top.trim())) !== fold(realpathSync(root))) return null;
  return root;
}
export function readReleaseSource(root = process.cwd()) {
  root = resolve(root);
  if (!gitWorkspace(root)) return { revision: null, tree: null, dirty: null };
  const revision = gitRead(root, ["rev-parse", "HEAD"]);
  const tree = gitRead(root, ["rev-parse", "HEAD^{tree}"]);
  const status = gitRead(root, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (!revision || !tree || status === null)
    throw Error("RELEASE_GIT_READ_FAILED");
  return {
    revision: revision.trim(),
    tree: tree.trim(),
    dirty: status.trim() !== "",
  };
}
export function verifyRelease(
  bytes,
  root = process.cwd(),
  { mode = "workspace" } = {},
) {
  root = resolve(root);
  if (!["workspace", "snapshot"].includes(mode))
    throw Error("RELEASE_VERIFICATION_MODE_INVALID");
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
      path.includes(":") ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || part === "." || !part)
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
    const base = path.startsWith("source/")
      ? root
      : resolve(process.env.DATA_DIR ?? resolve(root, "data/app"), "results");
    const original = resolve(
      base,
      path.slice(path.startsWith("source/") ? 7 : 8),
    );
    if (!existsSync(original))
      throw Error(`RELEASE_WORKSPACE_MISMATCH:${path}`);
    const rel = relative(realpathSync(base), realpathSync(original));
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith("../") ||
      rel.startsWith("..\\")
    )
      throw Error("RELEASE_UNSAFE_PATH");
    if (!existsSync(original) || sha256(readFileSync(original)) !== expected)
      throw Error(`RELEASE_WORKSPACE_MISMATCH:${path}`);
  }
  const source = JSON.parse(
    Buffer.from(files["RELEASE.json"]).toString("utf8"),
  ).source;
  const hash = (value) =>
    value === null ||
    (typeof value === "string" &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value));
  if (
    !source ||
    !hash(source.revision) ||
    !hash(source.tree) ||
    ![true, false, null].includes(source.dirty)
  )
    throw Error("RELEASE_SOURCE_METADATA_INVALID");
  const sourceVerified = mode === "workspace";
  if (sourceVerified) {
    const actual = readReleaseSource(root);
    if (!actual.revision)
      throw Error(
        "RELEASE_GIT_WORKSPACE_REQUIRED: use --snapshot for unverified Git provenance",
      );
    if (
      source.revision !== actual.revision ||
      source.tree !== actual.tree ||
      source.dirty !== actual.dirty
    )
      throw Error("RELEASE_SOURCE_REVISION_MISMATCH");
    const tracked = gitRead(root, ["ls-files", "-z"]);
    if (tracked === null) throw Error("RELEASE_GIT_READ_FAILED");
    for (const path of tracked.split("\0").filter(Boolean))
      if (!Object.hasOwn(files, `source/${path}`))
        throw Error(`RELEASE_SOURCE_COVERAGE:${path}`);
  }
  return {
    date: new Date().toISOString(),
    passed: true,
    files: Object.keys(files).length,
    bytes: bytes.length,
    sha256: sha256(bytes),
    source,
    sourceVerified,
    sourceCoverageVerified: sourceVerified,
    mode,
    checks: [
      "all internal file hashes match",
      "all included source, compiled files and selected evidence match workspace bytes",
      "runtime data, private keys and dependencies excluded",
      ...(sourceVerified
        ? [
            "source revision, tree and worktree state match Git",
            "all tracked source files included",
          ]
        : [
            "Git source provenance and tracked coverage NOT verified (snapshot mode)",
          ]),
    ],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const reportPath = "release/verification.json";
  try {
    writeFileSync(
      reportPath,
      JSON.stringify(
        { date: new Date().toISOString(), passed: false, status: "verifying" },
        null,
        2,
      ),
    );
    const bytes = readFileSync("release/ContentProof.zip");
    const expected = readFileSync("release/SHA256SUMS", "utf8").trim();
    if (expected !== `${sha256(bytes)}  ContentProof.zip`)
      throw Error("RELEASE_ARCHIVE_DIGEST_MISMATCH");
    if (process.argv.slice(2).some((arg) => arg !== "--snapshot"))
      throw Error("RELEASE_VERIFICATION_ARGUMENT_INVALID");
    const report = verifyRelease(bytes, process.cwd(), {
      mode: process.argv.includes("--snapshot") ? "snapshot" : "workspace",
    });
    report.checks.unshift("archive SHA256 matches external checksum");
    writeFileSync("release/verification.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          passed: false,
          status: "failed",
          error: error.message,
        },
        null,
        2,
      ),
    );
    throw error;
  }
}
