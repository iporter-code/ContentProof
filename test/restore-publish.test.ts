import { it, expect, vi, afterEach } from "vitest";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { publishRestore } from "../packages/persistence/restore-publish.js";
afterEach(() => vi.mocked(renameSync).mockReset());
function fixture() {
  mkdirSync("data/test-publish", { recursive: true });
  const root = mkdtempSync(resolve("data/test-publish/run-")),
    target = resolve(root, "restored"),
    stage = target + ".restore-0123456789abcdef";
  mkdirSync(stage);
  writeFileSync(resolve(stage, "verified"), "synthetic");
  return { target, stage };
}
it("retries a transient sharing violation and publishes the original verified stage", async () => {
  const f = fixture();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(renameSync)
    .mockImplementationOnce(() => {
      throw Object.assign(Error("busy"), { code: "EPERM" });
    })
    .mockImplementation(actual.renameSync);
  await publishRestore(f.stage, f.target);
  expect(readFileSync(resolve(f.target, "verified"), "utf8")).toBe("synthetic");
  expect(renameSync).toHaveBeenCalledTimes(2);
});
it("preserves a target created while waiting for a transient error", async () => {
  const f = fixture();
  vi.mocked(renameSync).mockImplementation(() => {
    mkdirSync(f.target);
    writeFileSync(resolve(f.target, "other"), "do not replace");
    throw Object.assign(Error("busy"), { code: "EBUSY" });
  });
  await expect(publishRestore(f.stage, f.target)).rejects.toThrow(
    "REQUIRES_NEW_DIRECTORY",
  );
  expect(renameSync).toHaveBeenCalledTimes(1);
  expect(existsSync(f.stage)).toBe(true);
  expect(readFileSync(resolve(f.target, "other"), "utf8")).toBe(
    "do not replace",
  );
});
it("does not retry unrelated errors or accept arbitrary source directories", async () => {
  const f = fixture();
  vi.mocked(renameSync).mockImplementation(() => {
    throw Object.assign(Error("io failure"), { code: "EIO" });
  });
  await expect(publishRestore(f.stage, f.target)).rejects.toThrow("io failure");
  expect(renameSync).toHaveBeenCalledTimes(1);
  expect(existsSync(f.stage)).toBe(true);
  await expect(publishRestore(f.stage, f.target + "-other")).rejects.toThrow(
    "UNSAFE_RESTORE_STAGE",
  );
});
