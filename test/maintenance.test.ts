import { it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import {
  backupData,
  restoreData,
  rotateStorage,
  collectOrphans,
} from "../packages/persistence/maintenance.js";
import { acquireLock } from "../packages/persistence/locks.js";
import {
  prepareExternalRotation,
  recoverExternalRotation,
  rotateExternalStorage,
} from "../packages/persistence/external-rotation.js";
mkdirSync("data/test-maintenance", { recursive: true });
function fixture() {
  const root = mkdtempSync(resolve("data/test-maintenance/run-")),
    source = resolve(root, "source");
  mkdirSync(resolve(source, "objects"), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(resolve(source, "storage.key"), key);
  const db = new DatabaseSync(resolve(source, "contentproof.sqlite"));
  db.exec(
    "CREATE TABLE assets(digest TEXT PRIMARY KEY);CREATE TABLE claims(id TEXT PRIMARY KEY,encrypted TEXT);CREATE TABLE drafts(id TEXT PRIMARY KEY,json TEXT);CREATE TABLE exports(id TEXT PRIMARY KEY,input TEXT,state TEXT,lease TEXT,leaseUntil INTEGER)",
  );
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv),
    out = Buffer.concat([
      cipher.update(JSON.stringify({ secret: "private-field" })),
      cipher.final(),
    ]);
  db.prepare("INSERT INTO claims VALUES(?,?)").run(
    "claim",
    Buffer.concat([iv, cipher.getAuthTag(), out]).toString("base64"),
  );
  const plain = Buffer.from("legacy-plaintext-image"),
    name = createHash("sha256").update(plain).digest("hex");
  db.prepare("INSERT INTO assets VALUES(?)").run(`0x${name}`);
  db.close();
  writeFileSync(resolve(source, "objects", name), plain);
  return { root, source, name, key };
}
it("encrypted backup restores byte-identical records and rejects overwrite/wrong password/tampering", async () => {
  const f = fixture(),
    backup = resolve(f.root, "backup"),
    target = resolve(f.root, "restored");
  await backupData(f.source, backup, "backup-test-password-2026");
  expect(
    readFileSync(resolve(backup, "manifest.enc")).includes(
      Buffer.from("private-field"),
    ),
  ).toBe(false);
  await expect(
    restoreData(backup, target, "wrong-password-that-is-long"),
  ).rejects.toThrow();
  expect(existsSync(target)).toBe(false);
  await restoreData(backup, target, "backup-test-password-2026");
  expect(readFileSync(resolve(target, "objects", f.name))).toEqual(
    readFileSync(resolve(f.source, "objects", f.name)),
  );
  await expect(
    restoreData(backup, target, "backup-test-password-2026"),
  ).rejects.toThrow("NEW_DIRECTORY");
  const entry = resolve(backup, "00000000.enc"),
    b = readFileSync(entry);
  b[b.length - 1] ^= 1;
  writeFileSync(entry, b);
  await expect(
    restoreData(
      backup,
      resolve(f.root, "corrupt"),
      "backup-test-password-2026",
    ),
  ).rejects.toThrow();
  expect(existsSync(resolve(f.root, "corrupt"))).toBe(false);
});
it("external storage secrets are included in authenticated backups without a local key file", async () => {
  const f = fixture(),
    backup = resolve(f.root, "external-backup"),
    target = resolve(f.root, "external-restored");
  renameSync(
    resolve(f.source, "storage.key"),
    resolve(f.root, "external-secret.key"),
  );
  await backupData(f.source, backup, "external-backup-password-2026", f.key);
  await restoreData(backup, target, "external-backup-password-2026");
  expect(readFileSync(resolve(target, "storage.key"))).toEqual(f.key);
  expect(existsSync(resolve(f.source, "storage.key"))).toBe(false);
});
it("rotation reencrypts records and legacy media, retains the original rollback copy", () => {
  const f = fixture(),
    r = rotateStorage(f.source),
    key = readFileSync(resolve(f.source, "storage.key"));
  expect(key).not.toEqual(f.key);
  expect(existsSync(r.rollback)).toBe(true);
  const db = new DatabaseSync(resolve(f.source, "contentproof.sqlite"));
  const row = db.prepare("SELECT encrypted FROM claims").get() as any;
  db.close();
  const bytes = Buffer.from(row.encrypted, "base64"),
    d = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  d.setAuthTag(bytes.subarray(12, 28));
  expect(
    Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString(),
  ).toContain("private-field");
  expect(
    readFileSync(resolve(f.source, "objects", f.name))
      .subarray(0, 12)
      .toString(),
  ).toBe("CP-OBJECT-1\0");
  expect(readFileSync(resolve(r.rollback, "storage.key"))).toEqual(f.key);
});
it("maintenance refuses live services and garbage collection defaults to dry run", async () => {
  const f = fixture(),
    unlock = acquireLock(f.source, "api");
  try {
    await expect(
      backupData(
        f.source,
        resolve(f.root, "blocked"),
        "backup-test-password-2026",
      ),
    ).rejects.toThrow("BUSY");
  } finally {
    unlock();
  }
  if (process.platform === "linux") {
    // A stale lock can point to a live, unrelated PID in a recreated container.
    writeFileSync(
      resolve(f.source, ".api.lock"),
      JSON.stringify({
        pid: process.pid,
        identity: "previous-boot:previous-container:1",
        nonce: "crashed",
      }),
    );
    const release = acquireLock(f.source, "api");
    try {
      expect(() => acquireLock(f.source, "api")).toThrow("BUSY");
    } finally {
      release();
    }
  }
  const orphan = "a".repeat(64);
  writeFileSync(resolve(f.source, "objects", orphan), "orphan");
  expect(collectOrphans(f.source).candidates).toContain(orphan);
  expect(existsSync(resolve(f.source, "objects", orphan))).toBe(true);
  collectOrphans(f.source, true);
  expect(existsSync(resolve(f.source, "objects", orphan))).toBe(false);
  expect(existsSync(resolve(f.source, "objects", f.name))).toBe(true);
});
function externalFixture() {
  const f = fixture(),
    secret = resolve(f.root, "external-secret.hex");
  writeFileSync(secret, f.key.toString("hex"), { mode: 0o600 });
  return { ...f, secret };
}
function readSecret(path: string) {
  return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
}
function readableClaim(source: string, key: Buffer) {
  const db = new DatabaseSync(resolve(source, "contentproof.sqlite"));
  try {
    const row = db.prepare("SELECT encrypted FROM claims").get() as any,
      b = Buffer.from(row.encrypted, "base64"),
      d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString();
  } finally {
    db.close();
  }
}
it("external-file rotation commits a matching key/data pair and preserves both rollback copies", () => {
  const f = externalFixture(),
    r = rotateExternalStorage(f.source, f.secret),
    key = readSecret(f.secret);
  expect(key).not.toEqual(f.key);
  expect(readableClaim(f.source, key)).toContain("private-field");
  expect(existsSync(resolve(f.source, "storage.key"))).toBe(false);
  expect(readSecret(r.secretBackup)).toEqual(f.key);
  expect(readableClaim(r.rollback!, f.key)).toContain("private-field");
  const object = readFileSync(resolve(f.source, "objects", f.name)),
    d = createDecipheriv("aes-256-gcm", key, object.subarray(12, 24));
  d.setAuthTag(object.subarray(24, 40));
  expect(
    Buffer.concat([d.update(object.subarray(40)), d.final()]).toString(),
  ).toBe("legacy-plaintext-image");
  const release = acquireLock(f.source, "api");
  release();
});
it("prepared rotation blocks services/other maintenance and can roll back without changing active data or secret", () => {
  const f = externalFixture();
  prepareExternalRotation(f.source, f.secret);
  expect(readSecret(f.secret)).toEqual(f.key);
  expect(readableClaim(f.source, f.key)).toContain("private-field");
  expect(() => acquireLock(f.source, "api")).toThrow("RECOVERY_REQUIRED");
  expect(() => acquireLock(f.source, "maintenance")).toThrow(
    "RECOVERY_REQUIRED",
  );
  recoverExternalRotation(f.source, "rollback");
  expect(readSecret(f.secret)).toEqual(f.key);
  expect(readableClaim(f.source, f.key)).toContain("private-field");
});
it("recovery commits after a crash between old-directory and new-directory publication", () => {
  const f = externalFixture();
  prepareExternalRotation(f.source, f.secret);
  const j = JSON.parse(readFileSync(`${f.source}.key-rotation.json`, "utf8"));
  renameSync(f.source, `${f.source}.rollback-external-${j.tag}`);
  recoverExternalRotation(f.source, "commit");
  expect(readableClaim(f.source, readSecret(f.secret))).toContain(
    "private-field",
  );
  expect(existsSync(`${f.source}.key-rotation.json`)).toBe(false);
});
it("recovery handles a published key and data before journal removal, including rollback", () => {
  for (const action of ["commit", "rollback"] as const) {
    const f = externalFixture();
    prepareExternalRotation(f.source, f.secret);
    const j = JSON.parse(readFileSync(`${f.source}.key-rotation.json`, "utf8"));
    renameSync(f.source, `${f.source}.rollback-external-${j.tag}`);
    renameSync(`${f.source}.rotate-external-${j.tag}`, f.source);
    renameSync(`${f.secret}.rotate-${j.tag}`, f.secret);
    recoverExternalRotation(f.source, action);
    expect(readableClaim(f.source, readSecret(f.secret))).toContain(
      "private-field",
    );
    if (action === "rollback") {
      expect(readSecret(f.secret)).toEqual(f.key);
      expect(existsSync(`${f.source}.abandoned-${j.tag}`)).toBe(true);
    }
  }
});
it("external rotation rejects live services, wrong secret and out-of-band secret replacement", () => {
  const f = externalFixture(),
    release = acquireLock(f.source, "api");
  try {
    expect(() => prepareExternalRotation(f.source, f.secret)).toThrow("BUSY");
  } finally {
    release();
  }
  const wrong = resolve(f.root, "wrong.hex");
  writeFileSync(wrong, randomBytes(32).toString("hex"));
  expect(() => prepareExternalRotation(f.source, wrong)).toThrow();
  expect(readableClaim(f.source, f.key)).toContain("private-field");
  prepareExternalRotation(f.source, f.secret);
  writeFileSync(f.secret, randomBytes(32).toString("hex"));
  expect(() => recoverExternalRotation(f.source, "commit")).toThrow(
    "OUTSIDE_ROTATION",
  );
  expect(existsSync(`${f.source}.key-rotation.json`)).toBe(true);
});
