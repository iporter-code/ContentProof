import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import {
  coreSchema,
  verify,
  claimId,
  disclose,
  ZERO,
} from "../packages/protocol/index.js";
import { makeFull } from "./helpers.js";
import { migrateReliability } from "../packages/persistence/schema.js";
import { ResourcePool } from "../packages/media/resources.js";
import { writeBundle } from "../packages/bundle/stream.js";
it("operation semantics reject inconsistent input counts, engine binding and zero epoch", async () => {
  const m = await makeFull();
  expect(() => coreSchema.parse({ ...m.core, parentCount: 1 })).toThrow();
  expect(() => coreSchema.parse({ ...m.core, operation: "crop" })).toThrow();
  expect(() => coreSchema.parse({ ...m.core, keyEpoch: "0" })).toThrow();
  expect(() =>
    coreSchema.parse({
      ...m.core,
      operation: "compose",
      parentCount: 2,
      engineDigest: ZERO,
    }),
  ).toThrow();
});
it("interrupted verification reports incomplete rather than pass or evidence tampering", async () => {
  const m = disclose(await makeFull()),
    controller = new AbortController();
  controller.abort();
  const result = await verify(claimId(m), {
    manifests: new Map([[claimId(m), m]]),
    files: new Map(),
    signal: controller.signal,
  });
  expect(result.outcome).toBe("incomplete");
  expect(
    result.reasons.some((r) => r.code === "VERIFICATION_INTERRUPTED"),
  ).toBe(true);
});
it("schema migration enforces relations and preserves rejected legacy rows for review", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;PRAGMA user_version=2;
CREATE TABLE assets(digest TEXT PRIMARY KEY);CREATE TABLE claims(id TEXT PRIMARY KEY);CREATE TABLE drafts(id TEXT PRIMARY KEY);CREATE TABLE audit(id INTEGER PRIMARY KEY,owner TEXT);CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied TEXT);
CREATE TABLE asset_acl(digest TEXT,owner TEXT);CREATE TABLE asset_owners(digest TEXT,owner TEXT);CREATE TABLE claim_acl(id TEXT,owner TEXT);CREATE TABLE draft_signatures(draftId TEXT,claimId TEXT);
CREATE TABLE jobs(id TEXT PRIMARY KEY,owner TEXT,claimId TEXT,state TEXT,result TEXT,error TEXT,attempts INTEGER,updated TEXT,txHash TEXT,nextAttempt INTEGER,leaseUntil INTEGER);
INSERT INTO assets VALUES('valid');INSERT INTO asset_acl VALUES('valid','reader');INSERT INTO asset_acl VALUES('missing','reader');INSERT INTO jobs VALUES('orphan','reader','missing','queued',NULL,NULL,0,NULL,NULL,0,0);`);
  try {
    migrateReliability(db);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM migration_rejections").get()!.n,
    ).toBe(2);
    expect(() =>
      db.prepare("INSERT INTO asset_acl VALUES('missing','reader')").run(),
    ).toThrow();
    db.exec("DELETE FROM assets WHERE digest='valid'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM asset_acl").get()!.n).toBe(0);
    migrateReliability(db);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  } finally {
    db.close();
  }
});
it("media pool bounds active jobs and queue length and releases permits after failure", async () => {
  const pool = new ResourcePool(1, 1);
  let release!: () => void;
  const first = pool.run(() => new Promise<void>((r) => (release = r))),
    second = pool.run(async () => {
      throw Error("native failure");
    });
  const assertion = expect(second).rejects.toThrow("native failure");
  expect(pool.status()).toEqual({ active: 1, queued: 1, concurrency: 1 });
  await expect(pool.run(async () => 1)).rejects.toThrow("RESOURCE_LIMIT");
  release();
  await first;
  await assertion;
  expect(pool.status().active).toBe(0);
  expect(await pool.run(async () => 42)).toBe(42);
});
it("streaming bundle preflight includes ZIP overhead and rejects before loading oversized payload", async () => {
  let loaded = false;
  const rows = Array.from({ length: 7 }, (_, i) => ({
    path: `media/0x${String(i).padStart(64, "0")}`,
    size: 20 * 1024 * 1024,
    read: () => {
      loaded = true;
      return new Uint8Array();
    },
  }));
  await expect(
    writeBundle(
      `0x${"0".repeat(64)}`,
      rows,
      new Writable({
        write(_, __, cb) {
          cb();
        },
      }),
      () => {},
    ),
  ).rejects.toThrow("BUNDLE_SIZE_LIMIT");
  expect(loaded).toBe(false);
});
