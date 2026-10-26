import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  existsSync,
  lstatSync,
  renameSync,
} from "node:fs";
import { resolve, relative, sep } from "node:path";
import { zipSync } from "fflate";
import { hashBytes } from "../packages/protocol/index.js";
import { spawnSync } from "node:child_process";
import { dataDir } from "../packages/chain/index.js";
// @ts-expect-error JavaScript verifier is shared with the standalone CLI.
import { verifyRelease } from "./verify-release.mjs";
import {
  assertPublicReleaseFile,
  assertNoConfiguredSecret,
} from "./release-safety.js";
mkdirSync("release", { recursive: true });
writeFileSync(
  "release/verification.json",
  JSON.stringify(
    {
      date: new Date().toISOString(),
      passed: false,
      status: "building",
      scope: "Previous artifact is not current-source acceptance",
    },
    null,
    2,
  ),
);
mkdirSync(resolve(dataDir, "results"), { recursive: true });
const validations = [
  ["scripts/verify-notices.mjs"],
  ["--import", "tsx", "scripts/openapi.ts"],
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${resolve(dataDir, "results/release-tests.json")}`,
  ],
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.server.json"],
  [
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "apps/web/vite.config.ts",
  ],
];
for (const args of validations) {
  const check = spawnSync(process.execPath, args, {
    stdio: "inherit",
    windowsHide: true,
  });
  if (check.status !== 0) throw Error("RELEASE_VALIDATION_FAILED");
}
const tests = JSON.parse(
  readFileSync(resolve(dataDir, "results/release-tests.json"), "utf8"),
);
writeFileSync(
  resolve(dataDir, "results/release-validation.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      passed: true,
      node: process.version,
      platform: process.platform,
      tests: {
        total: tests.numTotalTests,
        passed: tests.numPassedTests,
        failed: tests.numFailedTests,
        pending: tests.numPendingTests,
      },
      checks: [
        "OpenAPI generation",
        "unit and regression tests",
        "TypeScript type checking",
        "compiled API and CLI",
        "production frontend build",
      ],
    },
    null,
    2,
  ),
);
const roots = [
  "apps",
  "packages",
  "scripts",
  "experiments",
  "test",
  "docs",
  "configs",
  "deploy",
  "dist/web",
  "dist/server",
  ".github/workflows",
];
const entries: Record<string, Uint8Array> = {};
function collect(path: string) {
  if (
    relative(process.cwd(), resolve(path)).split(sep).join("/") ===
    "deploy/runtime"
  )
    return;
  if (!existsSync(path)) return;
  for (const file of readdirSync(path)) {
    const p = resolve(path, file);
    assertPublicReleaseFile(p);
    if (lstatSync(p).isSymbolicLink()) throw Error("FORBIDDEN_RELEASE_SYMLINK");
    if (statSync(p).isDirectory()) collect(p);
    else {
      const rel = relative(process.cwd(), p).split(sep).join("/");
      if (/(?:\.env$|\.key$|contentproof\.sqlite|node_modules)/.test(rel))
        throw Error("FORBIDDEN_RELEASE_FILE");
      entries[`source/${rel}`] = readFileSync(p);
    }
  }
}
roots.forEach(collect);
for (const file of [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.server.json",
  "hardhat.config.ts",
  "vitest.config.ts",
  "README.md",
  "PROJECT_PLAN.md",
  "IMPLEMENTATION_STATUS.md",
  "COMPLETION_TRACKER.md",
  "PROJECT_ISSUES.md",
  "THIRD_PARTY_NOTICES.md",
  ".env.example",
  ".gitignore",
  ".dockerignore",
  ".prettierignore",
  ".gitattributes",
  "LICENSE",
])
  if (existsSync(file)) {
    assertPublicReleaseFile(file);
    entries[`source/${file}`] = readFileSync(file);
  }
// Demonstration evidence is intentionally excluded from the default release.
for (const file of [
  "e2e.json",
  "raw.jsonl",
  "performance.csv",
  "summary.json",
  "performance.svg",
  "browser-qa.md",
  "browser-verification.png",
  "api-stopped-report.json",
  "recovery.json",
])
  if (existsSync(`${dataDir}/results/${file}`))
    entries[`results/${file}`] = readFileSync(`${dataDir}/results/${file}`);
for (const file of [
  "business.json",
  "persistence.json",
  "config.json",
  "reliability.json",
  "scale-protocol.json",
  "qbft.json",
  "qbft-business.json",
  "rpc-failover.json",
  "media-win32.json",
  "media-linux.json",
  "container-business.json",
  "container-persistence.json",
  "container-crash-recovery.json",
  "docker-recovery.json",
  "release-validation.json",
  "local-engineering.json",
  "local-performance.json",
  "fault-recovery.json",
  "fault-recovery-linux.json",
  "qbft-partition.json",
  "codecs-win32.json",
  "codecs-linux.json",
  "image-inventory.json",
  "local-validation.json",
  "capacity.json",
  "browser-responsive.json",
  "browser-business.json",
  "browser-business-full-report.json",
  "browser-business-partial-report.json",
  "browser-business-withdrawn-report.json",
  "browser-business-withdrawn-verified.png",
  "vault-local.json",
  "vault-local-linux.json",
  "c2pa-native.json",
  "c2pa-native-linux.json",
  "c2pa-incompatible-runtime.json",
  "c2pa-browser.json",
  "c2pa-browser.png",
  "cloud-public-validation.json",
  "reorg-branches.json",
  "reorg-branches-linux.json",
  "media-boundaries.json",
  "media-boundaries-linux.json",
  "linux-current-validation.json",
  "soak-frozen-smoke.json",
  "soak-instrumentation-smoke.json",
])
  if (existsSync(`${dataDir}/results/${file}`))
    entries[`results/${file}`] = readFileSync(`${dataDir}/results/${file}`);
const forbidden = [process.cwd(), process.env.USERNAME].filter(
  (s): s is string => !!s && s.length >= 4,
);
for (const [path, bytes] of Object.entries(entries)) {
  if (/\.(md|ts|tsx|json|mjs|ps1|yml|css|html|sql)$/.test(path)) {
    const text = Buffer.from(bytes).toString("utf8");
    assertNoConfiguredSecret(text);
    for (const needle of forbidden)
      if (text.includes(needle))
        throw Error(
          `Anonymity check failed: ${path} contains local identity/path`,
        );
  }
}
const gitRead = (args: string[]) => {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
};
const source = {
  revision: gitRead(["rev-parse", "HEAD"]),
  tree: gitRead(["rev-parse", "HEAD^{tree}"]),
  dirty: gitRead(["status", "--porcelain", "--untracked-files=normal"]) !== "",
};
entries["RELEASE.json"] = Buffer.from(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      source,
      evidenceScope:
        "Only release-validation.json is generated by this release; other evidence keeps its original date and scope",
    },
    null,
    2,
  ),
);
entries["SHA256SUMS"] = Buffer.from(
  Object.entries(entries)
    .map(([p, b]) => `${hashBytes(b).slice(2)}  ${p}`)
    .join("\n") + "\n",
);
mkdirSync("release", { recursive: true });
const zip = zipSync(entries, { level: 6 });
const verification = verifyRelease(zip);
writeFileSync("release/ContentProof.zip.tmp", zip);
renameSync("release/ContentProof.zip.tmp", "release/ContentProof.zip");
writeFileSync(
  "release/SHA256SUMS",
  `${hashBytes(zip).slice(2)}  ContentProof.zip\n`,
);
verification.checks.unshift("archive SHA256 matches external checksum");
writeFileSync(
  "release/verification.json",
  JSON.stringify(verification, null, 2),
);
console.log(
  `Release ready: ${Object.keys(entries).length} files, ${(zip.length / 1024 / 1024).toFixed(2)} MB. No runtime database, storage encryption key, sessions or node_modules included.`,
);
