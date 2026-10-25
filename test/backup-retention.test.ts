import { it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error Standalone deployment helper is JavaScript.
import { pruneBackups } from "../deploy/cloud/backup-retention.mjs";
import {
  diskPressureSignal,
  AlertMonitor,
} from "../packages/operations/alerts.js";
function fixture() {
  mkdirSync("data/test-backup-retention", { recursive: true });
  const root = mkdtempSync(resolve("data/test-backup-retention/run-"));
  return root;
}
function complete(root: string, name: string) {
  const path = resolve(root, name);
  mkdirSync(path);
  writeFileSync(
    resolve(path, "backup.json"),
    JSON.stringify({ version: 1, salt: "00".repeat(16) }),
  );
  writeFileSync(resolve(path, "manifest.enc"), Buffer.alloc(32));
}
it("retention previews by default and removes only old complete backups beyond the minimum copy count", () => {
  const root = fixture();
  for (let i = 1; i <= 10; i++)
    complete(root, `202601${String(i).padStart(2, "0")}T033000Z`);
  mkdirSync(resolve(root, "20260111T033000Z"));
  mkdirSync(resolve(root, "notes"));
  const options = { days: 30, minCopies: 7, now: Date.UTC(2026, 9, 25) };
  const preview = pruneBackups(root, options);
  expect(preview.removed).toBe(0);
  expect(preview.candidates).toHaveLength(3);
  expect(existsSync(resolve(root, "20260101T033000Z"))).toBe(true);
  expect(pruneBackups(root, { ...options, apply: true }).removed).toBe(3);
  expect(pruneBackups(root, { ...options, apply: true }).removed).toBe(0);
  expect(existsSync(resolve(root, "20260104T033000Z"))).toBe(true);
  expect(existsSync(resolve(root, "20260111T033000Z"))).toBe(true);
  expect(existsSync(resolve(root, "notes"))).toBe(true);
});
it("retention preserves recent copies, ignores invalid completion markers and never follows directory links", () => {
  const root = fixture(),
    outside = fixture();
  complete(outside, "20250101T033000Z");
  symlinkSync(
    resolve(outside, "20250101T033000Z"),
    resolve(root, "20250101T033000Z"),
    process.platform === "win32" ? "junction" : "dir",
  );
  complete(root, "20261024T033000Z");
  complete(root, "20261023T033000Z");
  complete(root, "20250102T033000Z");
  writeFileSync(resolve(root, "20250102T033000Z", "backup.json"), "bad header");
  expect(
    pruneBackups(root, {
      days: 30,
      minCopies: 1,
      apply: true,
      now: Date.UTC(2026, 9, 25),
    }).removed,
  ).toBe(0);
  expect(existsSync(resolve(outside, "20250101T033000Z", "manifest.enc"))).toBe(
    true,
  );
  expect(() => pruneBackups(root, { days: 0 })).toThrow(
    "INVALID_BACKUP_RETENTION",
  );
  expect(() => pruneBackups(root, { minCopies: 0 })).toThrow(
    "INVALID_BACKUP_RETENTION",
  );
});
it("low disk alerts require sustained pressure and preserve recovery history without deleting data", () => {
  const records: { active: boolean }[] = [];
  const monitor = new AlertMonitor((_s, active) => records.push({ active }));
  monitor.sample([diskPressureSignal(10, 20)]);
  monitor.sample([diskPressureSignal(10, 20)]);
  expect(records).toHaveLength(0);
  monitor.sample([diskPressureSignal(10, 20)]);
  expect(records.at(-1)?.active).toBe(true);
  monitor.sample([diskPressureSignal(20, 20)]);
  monitor.sample([diskPressureSignal(21, 20)]);
  expect(records.at(-1)?.active).toBe(false);
  expect(() => diskPressureSignal(-1, 20)).toThrow("INVALID_DISK_SPACE_BUDGET");
});
