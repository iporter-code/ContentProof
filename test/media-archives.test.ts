import { it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { archivedWorker, executeArchived } from "../packages/media/archives.js";
const old = process.env.CP_MEDIA_ENGINES_FILE;
afterEach(() => {
  if (old === undefined) delete process.env.CP_MEDIA_ENGINES_FILE;
  else process.env.CP_MEDIA_ENGINES_FILE = old;
});
const sha = (bytes: Uint8Array | string) =>
    createHash("sha256").update(bytes).digest("hex"),
  id = `0x${"ab".repeat(32)}`;
function fixture() {
  mkdirSync("data/test-media-archives", { recursive: true });
  const root = mkdtempSync(resolve("data/test-media-archives/run-")),
    directory = resolve(root, "engine");
  mkdirSync(directory);
  const code =
    "process.once('message',()=>process.send({ok:true,result:Buffer.from('historical result')}));";
  writeFileSync(resolve(directory, "worker.cjs"), code);
  const descriptor = {
    version: 1,
    engineDigest: id,
    platform: String(process.platform),
    arch: process.arch,
    worker: "worker.cjs",
    versions: { sharp: "fixture" },
    files: { "worker.cjs": sha(code) },
  };
  const catalog = {
    version: 1,
    engines: [{ engineDigest: id, directory: "engine", descriptorSha256: "" }],
  };
  function save() {
    writeFileSync(
      resolve(directory, "engine.json"),
      JSON.stringify(descriptor),
    );
    catalog.engines[0].descriptorSha256 = sha(
      readFileSync(resolve(directory, "engine.json")),
    );
    writeFileSync(resolve(root, "catalog.json"), JSON.stringify(catalog));
  }
  save();
  return {
    root,
    directory,
    descriptor,
    catalog,
    save,
    file: resolve(root, "catalog.json"),
  };
}
it("only explicitly configured pinned archives run in bounded child workers", async () => {
  delete process.env.CP_MEDIA_ENGINES_FILE;
  expect(archivedWorker(id)).toBeUndefined();
  const f = fixture();
  process.env.CP_MEDIA_ENGINES_FILE = f.file;
  expect(archivedWorker(`0x${"cd".repeat(32)}`)).toBeUndefined();
  expect(
    (
      await executeArchived(id, "resize", [Buffer.from("input")], {})
    )?.toString(),
  ).toBe("historical result");
});
it("modified and unlisted archive code is rejected before execution", () => {
  const f = fixture();
  writeFileSync(resolve(f.directory, "worker.cjs"), "tampered");
  expect(() => archivedWorker(id, f.file)).toThrow("INTEGRITY_FAILED");
  const g = fixture();
  writeFileSync(resolve(g.directory, "extra.cjs"), "extra");
  expect(() => archivedWorker(id, g.file)).toThrow("INTEGRITY_FAILED");
});
it("wrong platform, ambiguous mappings and unsafe paths are rejected", () => {
  const f = fixture();
  f.descriptor.platform = "different-platform";
  f.save();
  expect(() => archivedWorker(id, f.file)).toThrow("PLATFORM_MISMATCH");
  const g = fixture();
  g.catalog.engines.push(g.catalog.engines[0]);
  g.save();
  expect(() => archivedWorker(id, g.file)).toThrow("AMBIGUOUS");
  const h = fixture();
  h.catalog.engines[0].directory = "../outside";
  h.save();
  expect(() => archivedWorker(id, h.file)).toThrow();
});
