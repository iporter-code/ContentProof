import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  writeSnapshotManifest,
  verifySnapshotManifest,
} from "../packages/operations/snapshot.js";
function fixture() {
  mkdirSync("data/test-snapshots", { recursive: true });
  const root = mkdtempSync(resolve("data/test-snapshots/run-"));
  mkdirSync(resolve(root, "node_modules/library"), { recursive: true });
  mkdirSync(resolve(root, "data"));
  writeFileSync(resolve(root, "node_modules/library/index.js"), "original");
  return root;
}
it("freezes dependency bytes while allowing isolated workload data to grow", () => {
  const root = fixture(),
    digest = writeSnapshotManifest(root);
  writeFileSync(resolve(root, "data/progress.json"), "{}");
  expect(verifySnapshotManifest(root)).toBe(digest);
  writeFileSync(resolve(root, "node_modules/library/index.js"), "changed");
  expect(() => verifySnapshotManifest(root)).toThrow("SNAPSHOT_FILES_CHANGED");
});
it("rejects extra executable files, replaced manifests and runtime changes", () => {
  const root = fixture();
  writeSnapshotManifest(root);
  writeFileSync(resolve(root, "extra.js"), "injected");
  expect(() => verifySnapshotManifest(root)).toThrow("SNAPSHOT_FILES_CHANGED");
  const other = fixture();
  writeSnapshotManifest(other);
  const path = resolve(other, "snapshot-manifest.json"),
    manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.runtimeSha256 = "00".repeat(32);
  writeFileSync(path, JSON.stringify(manifest));
  expect(() => verifySnapshotManifest(other)).toThrow(
    "SNAPSHOT_RUNTIME_CHANGED",
  );
});
