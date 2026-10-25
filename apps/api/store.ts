import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { dataDir } from "../../packages/chain/index.js";
import type { PrivateManifest } from "../../packages/protocol/index.js";
import { migrateReliability } from "../../packages/persistence/schema.js";
import { acquireLock } from "../../packages/persistence/locks.js";
import { loadConfiguredSecrets } from "../../packages/config/secrets.js";
import { loadStorageKey } from "../../packages/persistence/storage-key.js";
import {
  activeAssetGrant,
  activeClaimGrant,
} from "../../packages/persistence/access.js";
if (existsSync(`${dataDir}.key-rotation.json`))
  throw Error("KEY_ROTATION_RECOVERY_REQUIRED");
await loadConfiguredSecrets();
export const releaseStoreLock = acquireLock(dataDir, "api");
mkdirSync(resolve(dataDir, "objects"), { recursive: true });
const key = loadStorageKey(dataDir, process.env.STORAGE_KEY);
export const db = new DatabaseSync(resolve(dataDir, "contentproof.sqlite"));
db.function("cp_now", () => Date.now());
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS assets(digest TEXT PRIMARY KEY, meta TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_acl(digest TEXT, owner TEXT, PRIMARY KEY(digest,owner));
CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY, owner TEXT NOT NULL, encrypted TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claim_acl(id TEXT, owner TEXT, PRIMARY KEY(id,owner));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, address TEXT, message TEXT, expires INTEGER, consumed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT, claimId TEXT UNIQUE, state TEXT, result TEXT, error TEXT, attempts INTEGER DEFAULT 0, updated TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, owner TEXT, action TEXT, objectId TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS chain_events(eventKey TEXT PRIMARY KEY, blockNumber TEXT, blockHash TEXT, json TEXT);
CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, blockNumber TEXT, blockHash TEXT);
`);
// Additive migration: never overwrite an existing newer schema version.
const schemaVersion = Number(
  (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version,
);
if (schemaVersion > 6) throw Error("DATABASE_NEWER_THAN_APPLICATION");
if (schemaVersion < 2) {
  db.exec(`BEGIN;
CREATE TABLE IF NOT EXISTS profiles(address TEXT PRIMARY KEY,name TEXT NOT NULL,epoch TEXT NOT NULL DEFAULT '1',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS asset_owners(digest TEXT NOT NULL,owner TEXT NOT NULL,PRIMARY KEY(digest,owner));
CREATE TABLE IF NOT EXISTS action_nonces(nonce TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS draft_signatures(draftId TEXT,claimId TEXT,PRIMARY KEY(draftId,claimId));
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied TEXT NOT NULL);
INSERT OR IGNORE INTO schema_migrations VALUES(2,datetime('now'));
PRAGMA user_version=2;COMMIT;`);
}
const jobColumns = new Set(
  (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map(
    (x) => x.name,
  ),
);
for (const [name, type] of [
  ["txHash", "TEXT"],
  ["nextAttempt", "INTEGER DEFAULT 0"],
  ["leaseUntil", "INTEGER DEFAULT 0"],
] as const)
  if (!jobColumns.has(name))
    db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
migrateReliability(db);
db.exec("PRAGMA busy_timeout=5000");
export const one = (sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).get(...args) as Record<string, any> | undefined;
export const all = (sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).all(...args) as Record<string, any>[];
export const run = (sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).run(...args);
export function encrypt(value: unknown): string {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    c.update(JSON.stringify(value), "utf8"),
    c.final(),
  ]);
  return Buffer.concat([iv, c.getAuthTag(), ciphertext]).toString("base64");
}
export function decrypt<T>(text: string): T {
  const bytes = Buffer.from(text, "base64"),
    d = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  d.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([d.update(bytes.subarray(28)), d.final()]).toString("utf8"),
  );
}
const OBJECT_MAGIC = Buffer.from("CP-OBJECT-1\0");
export function encryptObject(bytes: Uint8Array): Buffer {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([OBJECT_MAGIC, iv, c.getAuthTag(), encrypted]);
}
export function objectCipher() {
  const iv = randomBytes(12);
  return {
    iv,
    cipher: createCipheriv("aes-256-gcm", key, iv),
    magic: OBJECT_MAGIC,
  };
}
export function objectDecipher(header: Buffer) {
  if (!header.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC))
    throw Error("INVALID_ENCRYPTED_OBJECT");
  const n = OBJECT_MAGIC.length,
    d = createDecipheriv("aes-256-gcm", key, header.subarray(n, n + 12));
  d.setAuthTag(header.subarray(n + 12, n + 28));
  return { decipher: d, offset: n + 28 };
}
export function decryptObject(bytes: Buffer): Buffer {
  if (!bytes.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC))
    return bytes;
  const n = OBJECT_MAGIC.length,
    d = createDecipheriv("aes-256-gcm", key, bytes.subarray(n, n + 12));
  d.setAuthTag(bytes.subarray(n + 12, n + 28));
  return Buffer.concat([d.update(bytes.subarray(n + 28)), d.final()]);
}
export function objectPath(digest: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(digest)) throw new Error("INVALID_DIGEST");
  return resolve(dataDir, "objects", digest.slice(2));
}
export function assetAccess(digest: string, owner: string) {
  return (
    !!one(
      `SELECT digest FROM asset_acl p WHERE p.digest=? AND p.owner=? AND ${activeAssetGrant}`,
      digest,
      owner,
    ) ||
    !!one(
      "SELECT a.digest FROM organization_assets a JOIN organization_members m ON m.orgId=a.orgId JOIN organizations o ON o.id=a.orgId WHERE a.digest=? AND m.address=? AND m.status='active' AND o.status='approved'",
      digest,
      owner,
    )
  );
}
export function assetEdit(digest: string, owner: string) {
  return (
    !!one(
      `SELECT digest FROM asset_owners WHERE digest=? AND owner=? UNION SELECT p.digest FROM asset_acl p JOIN asset_editors v ON v.digest=p.digest AND v.owner=p.owner WHERE p.digest=? AND p.owner=? AND ${activeAssetGrant}`,
      digest,
      owner,
      digest,
      owner,
    ) ||
    !!one(
      "SELECT a.digest FROM organization_assets a JOIN organization_members m ON m.orgId=a.orgId JOIN organizations o ON o.id=a.orgId WHERE a.digest=? AND m.address=? AND m.status='active' AND m.role IN ('owner','admin','editor') AND a.permission='edit' AND o.status='approved'",
      digest,
      owner,
    )
  );
}
export function getClaim(id: string, owner: string): PrivateManifest {
  if (
    !one(
      `SELECT id FROM claim_acl p WHERE p.id=? AND p.owner=? AND ${activeClaimGrant}`,
      id,
      owner,
    ) &&
    !one(
      "SELECT c.claimId FROM organization_claims c JOIN organization_members m ON m.orgId=c.orgId JOIN organizations o ON o.id=c.orgId WHERE c.claimId=? AND m.address=? AND m.status='active' AND o.status='approved'",
      id,
      owner,
    )
  )
    throw new Error("FORBIDDEN");
  const row = one("SELECT encrypted FROM claims WHERE id=?", id);
  if (!row) throw new Error("CLAIM_NOT_FOUND");
  return decrypt<PrivateManifest>(row.encrypted);
}
export function audit(owner: string, action: string, objectId: string) {
  run(
    "INSERT INTO audit(owner,action,objectId,created) VALUES(?,?,?,?)",
    owner,
    action,
    objectId,
    new Date().toISOString(),
  );
}
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function writeGrant(
  kind: "asset" | "claim",
  resource: string,
  grantee: string,
  expires: number | null,
  permission: "read" | "edit" = "read",
) {
  if (
    expires !== null &&
    (!Number.isSafeInteger(expires) || expires <= Date.now())
  )
    throw Error("INVALID_GRANT_EXPIRY");
  const table = kind === "asset" ? "asset" : "claim",
    column = kind === "asset" ? "digest" : "id";
  if (
    expires !== null &&
    one(
      kind === "asset"
        ? "SELECT digest FROM asset_owners WHERE digest=? AND owner=?"
        : "SELECT id FROM claims WHERE id=? AND owner=?",
      resource,
      grantee,
    )
  )
    throw Error("CANNOT_EXPIRE_OWNER");
  run(`INSERT OR IGNORE INTO ${table}_acl VALUES(?,?)`, resource, grantee);
  if (expires === null)
    run(
      `DELETE FROM ${table}_grant_expiries WHERE ${column}=? AND owner=?`,
      resource,
      grantee,
    );
  else
    run(
      `INSERT INTO ${table}_grant_expiries VALUES(?,?,?) ON CONFLICT(${column},owner) DO UPDATE SET expires=excluded.expires`,
      resource,
      grantee,
      expires,
    );
  if (kind === "asset")
    run(
      permission === "edit"
        ? "INSERT OR IGNORE INTO asset_editors VALUES(?,?)"
        : "DELETE FROM asset_editors WHERE digest=? AND owner=?",
      resource,
      grantee,
    );
}
export function expireGrants() {
  transaction(() => {
    run(
      "DELETE FROM asset_editors WHERE EXISTS(SELECT 1 FROM asset_grant_expiries e WHERE e.digest=asset_editors.digest AND e.owner=asset_editors.owner AND e.expires<=cp_now())",
    );
    run(
      "DELETE FROM asset_acl WHERE EXISTS(SELECT 1 FROM asset_grant_expiries e WHERE e.digest=asset_acl.digest AND e.owner=asset_acl.owner AND e.expires<=cp_now())",
    );
    run(
      "DELETE FROM claim_acl WHERE EXISTS(SELECT 1 FROM claim_grant_expiries e WHERE e.id=claim_acl.id AND e.owner=claim_acl.owner AND e.expires<=cp_now())",
    );
  });
}
