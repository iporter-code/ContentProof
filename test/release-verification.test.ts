import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
// @ts-expect-error Shared with the standalone artifact verifier.
import { verifyRelease } from "../scripts/verify-release.mjs";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fixture() {
  mkdirSync("data/test-release-verification", { recursive: true });
  const root = mkdtempSync(resolve("data/test-release-verification/run-"));
  writeFileSync(resolve(root, "example.ts"), "export const value = 1;\n");
  const files: Record<string, Uint8Array> = {
    "source/example.ts": Buffer.from("export const value = 1;\n"),
    "RELEASE.json": Buffer.from(
      JSON.stringify({ source: { revision: "synthetic" } }),
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
