import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { zipSync } from "fflate";
import {
  verifyRelease,
  readReleaseSource,
} from "../scripts/verify-release.mjs";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fixture() {
  mkdirSync("data/test-release-verification", { recursive: true });
  const root = mkdtempSync(resolve("data/test-release-verification/run-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      stdio: "pipe",
      windowsHide: true,
    });
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  writeFileSync(resolve(root, "example.ts"), "export const value = 1;\n");
  git("add", "example.ts");
  git(
    "-c",
    "user.name=Synthetic Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Synthetic release fixture",
  );
  const files: Record<string, Uint8Array> = {
    "source/example.ts": Buffer.from("export const value = 1;\n"),
    "RELEASE.json": Buffer.from(
      JSON.stringify({ source: readReleaseSource(root) }),
    ),
  };
  const pack = () =>
    zipSync({
      ...files,
      SHA256SUMS: Buffer.from(
        Object.entries(files)
          .map(([p, b]) => `${hash(b)}  ${p}`)
          .join("\n") + "\n",
      ),
    });
  return { root, files, pack };
}
it("rejects a previously valid release after the source changes", () => {
  const f = fixture(),
    bytes = f.pack();
  expect(verifyRelease(bytes, f.root).passed).toBe(true);
  writeFileSync(resolve(f.root, "example.ts"), "export const value = 2;\n");
  expect(() => verifyRelease(bytes, f.root)).toThrow(
    "RELEASE_WORKSPACE_MISMATCH",
  );
});
it("rejects a tracked source omission even when the archive manifest is self-consistent", () => {
  const f = fixture();
  delete f.files["source/example.ts"];
  expect(() => verifyRelease(f.pack(), f.root)).toThrow(
    "RELEASE_SOURCE_COVERAGE:example.ts",
  );
});
it.each(["revision", "tree", "dirty"])(
  "checks declared source %s against the real Git workspace",
  (field) => {
    const f = fixture();
    const metadata = JSON.parse(
      Buffer.from(f.files["RELEASE.json"]).toString(),
    );
    metadata.source[field] = field === "dirty" ? true : "0".repeat(40);
    f.files["RELEASE.json"] = Buffer.from(JSON.stringify(metadata));
    expect(() => verifyRelease(f.pack(), f.root)).toThrow(
      "RELEASE_SOURCE_REVISION_MISMATCH",
    );
  },
);
it("requires explicit snapshot mode without a Git root and marks provenance and tracked coverage unverified", () => {
  const f = fixture();
  const snapshot = mkdtempSync(
    resolve("data/test-release-verification/snapshot-"),
  );
  writeFileSync(resolve(snapshot, "example.ts"), f.files["source/example.ts"]);
  expect(() => verifyRelease(f.pack(), snapshot)).toThrow(
    "RELEASE_GIT_WORKSPACE_REQUIRED",
  );
  expect(verifyRelease(f.pack(), snapshot, { mode: "snapshot" })).toMatchObject(
    {
      passed: true,
      sourceVerified: false,
      sourceCoverageVerified: false,
      mode: "snapshot",
    },
  );
});
it("rejects Windows drive paths before reading outside the selected workspace", () => {
  const f = fixture();
  f.files["source/C:/outside.txt"] = Buffer.from("synthetic");
  expect(() => verifyRelease(f.pack(), f.root)).toThrow("RELEASE_UNSAFE_PATH");
});
it("the CLI replaces an earlier success report when the next verification fails", () => {
  const f = fixture();
  writeFileSync(resolve(f.root, ".git/info/exclude"), "release/\n");
  mkdirSync(resolve(f.root, "release"));
  const save = () => {
    const bytes = f.pack();
    writeFileSync(resolve(f.root, "release/ContentProof.zip"), bytes);
    writeFileSync(
      resolve(f.root, "release/SHA256SUMS"),
      `${hash(bytes)}  ContentProof.zip\n`,
    );
  };
  save();
  const script = resolve("scripts/verify-release.mjs");
  execFileSync(process.execPath, [script], {
    cwd: f.root,
    stdio: "pipe",
    windowsHide: true,
  });
  const read = () =>
    JSON.parse(
      readFileSync(resolve(f.root, "release/verification.json"), "utf8"),
    );
  expect(read().passed).toBe(true);
  const metadata = JSON.parse(Buffer.from(f.files["RELEASE.json"]).toString());
  metadata.source.revision = "0".repeat(40);
  f.files["RELEASE.json"] = Buffer.from(JSON.stringify(metadata));
  save();
  expect(() =>
    execFileSync(process.execPath, [script], {
      cwd: f.root,
      stdio: "pipe",
      windowsHide: true,
    }),
  ).toThrow();
  expect(read()).toMatchObject({
    passed: false,
    status: "failed",
    error: "RELEASE_SOURCE_REVISION_MISMATCH",
  });
});
it("rejects missing entries and entries whose content was changed after hashing", () => {
  const f = fixture(),
    original = f.pack();
  const changed = {
    ...f.files,
    SHA256SUMS: Buffer.from(
      `0000000000000000000000000000000000000000000000000000000000000000  source/example.ts\n${hash(f.files["RELEASE.json"])}  RELEASE.json\n`,
    ),
  };
  expect(() => verifyRelease(zipSync(changed), f.root)).toThrow(
    "RELEASE_ENTRY_DIGEST_MISMATCH",
  );
  expect(verifyRelease(original, f.root).passed).toBe(true);
  delete f.files["RELEASE.json"];
  expect(() => verifyRelease(f.pack(), f.root)).toThrow(
    "RELEASE_MANIFEST_MISSING",
  );
});
it("rejects runtime data even with a self-consistent manifest", () => {
  const f = fixture();
  f.files["source/data/storage.key"] = Buffer.from("synthetic-key");
  expect(() => verifyRelease(f.pack(), f.root)).toThrow("RELEASE_RUNTIME_FILE");
});
