import type { DatabaseSync } from "node:sqlite";
export function migrateReliability(db: DatabaseSync) {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as any).user_version,
  );
  if (version > 6) throw Error("DATABASE_NEWER_THAN_APPLICATION");
  if (version === 6) return;
  if (version === 5) {
    db.exec(
      `BEGIN IMMEDIATE;CREATE TABLE operator_alerts(id TEXT PRIMARY KEY,code TEXT NOT NULL,severity TEXT NOT NULL CHECK(severity IN ('warning','error')),description TEXT NOT NULL,value REAL NOT NULL,threshold REAL NOT NULL,firstSeen INTEGER NOT NULL,lastSeen INTEGER NOT NULL,occurrences INTEGER NOT NULL DEFAULT 1,acknowledgedAt INTEGER,resolvedAt INTEGER);CREATE UNIQUE INDEX alert_active_code ON operator_alerts(code) WHERE resolvedAt IS NULL;CREATE INDEX alert_time ON operator_alerts(lastSeen);INSERT INTO schema_migrations VALUES(6,datetime('now'));PRAGMA user_version=6;COMMIT;`,
    );
    return;
  }
  if (version === 4) {
    db.exec(`BEGIN IMMEDIATE;
CREATE TABLE asset_grant_expiries(digest TEXT NOT NULL,owner TEXT NOT NULL,expires INTEGER NOT NULL CHECK(expires>0),PRIMARY KEY(digest,owner),FOREIGN KEY(digest,owner) REFERENCES asset_acl(digest,owner) ON DELETE CASCADE);
CREATE TABLE claim_grant_expiries(id TEXT NOT NULL,owner TEXT NOT NULL,expires INTEGER NOT NULL CHECK(expires>0),PRIMARY KEY(id,owner),FOREIGN KEY(id,owner) REFERENCES claim_acl(id,owner) ON DELETE CASCADE);
CREATE INDEX asset_expiry_time ON asset_grant_expiries(expires);
CREATE INDEX claim_expiry_time ON claim_grant_expiries(expires);
INSERT INTO schema_migrations VALUES(5,datetime('now'));PRAGMA user_version=5;COMMIT;`);
    migrateReliability(db);
    return;
  }
  if (version === 3) {
    db.exec(
      `BEGIN IMMEDIATE;CREATE TABLE asset_editors(digest TEXT NOT NULL REFERENCES assets(digest) ON DELETE CASCADE,owner TEXT NOT NULL,PRIMARY KEY(digest,owner));INSERT INTO schema_migrations VALUES(4,datetime('now'));PRAGMA user_version=4;COMMIT;`,
    );
    migrateReliability(db);
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
CREATE TABLE IF NOT EXISTS migration_rejections(id INTEGER PRIMARY KEY,source TEXT NOT NULL,row_json TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','suspended')),applicant TEXT NOT NULL,evidenceDigest TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE organization_members(orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,address TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),status TEXT NOT NULL CHECK(status IN ('invited','active')),PRIMARY KEY(orgId,address));
CREATE TABLE organization_reviews(id INTEGER PRIMARY KEY,orgId TEXT NOT NULL REFERENCES organizations(id),reviewer TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE organization_assets(orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,digest TEXT NOT NULL REFERENCES assets(digest) ON DELETE CASCADE,permission TEXT NOT NULL CHECK(permission IN ('read','edit')),PRIMARY KEY(orgId,digest));
CREATE TABLE organization_claims(orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,claimId TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,PRIMARY KEY(orgId,claimId));
CREATE TABLE exports(id TEXT PRIMARY KEY,owner TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancelled','expired')),progress INTEGER NOT NULL DEFAULT 0,lease TEXT,leaseUntil INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,error TEXT,bytes INTEGER,created INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE INDEX exports_queue ON exports(state,leaseUntil,created);
CREATE TABLE export_links(tokenHash TEXT PRIMARY KEY,exportId TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE INDEX memberships_address ON organization_members(address,status);
`);
    // Rebuild existing relation tables with enforced foreign keys. Preserve rejected
    // legacy rows for an operator to inspect rather than silently discard them.
    for (const [table, fields, parent, ref, columns] of [
      [
        "asset_acl",
        "digest TEXT NOT NULL REFERENCES assets(digest) ON DELETE CASCADE,owner TEXT NOT NULL,PRIMARY KEY(digest,owner)",
        "assets",
        "digest",
        "digest,owner",
      ],
      [
        "asset_owners",
        "digest TEXT NOT NULL REFERENCES assets(digest) ON DELETE CASCADE,owner TEXT NOT NULL,PRIMARY KEY(digest,owner)",
        "assets",
        "digest",
        "digest,owner",
      ],
      [
        "claim_acl",
        "id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,owner TEXT NOT NULL,PRIMARY KEY(id,owner)",
        "claims",
        "id",
        "id,owner",
      ],
    ]) {
      const rows = db
        .prepare(
          `SELECT * FROM ${table} WHERE ${ref} NOT IN (SELECT ${ref} FROM ${parent}) OR ${ref} IS NULL OR owner IS NULL`,
        )
        .all();
      for (const row of rows)
        db.prepare(
          "INSERT INTO migration_rejections(source,row_json,created) VALUES(?,?,?)",
        ).run(table, JSON.stringify(row), new Date().toISOString());
      db.exec(
        `CREATE TABLE ${table}_v3(${fields}); INSERT INTO ${table}_v3(${columns}) SELECT ${columns} FROM ${table} WHERE ${ref} IN (SELECT ${ref} FROM ${parent}) AND owner IS NOT NULL; DROP TABLE ${table}; ALTER TABLE ${table}_v3 RENAME TO ${table};`,
      );
    }
    for (const [table, ddl, columns, predicate] of [
      [
        "jobs",
        "id TEXT PRIMARY KEY,owner TEXT NOT NULL,claimId TEXT NOT NULL UNIQUE REFERENCES claims(id),state TEXT NOT NULL,result TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,updated TEXT,txHash TEXT,nextAttempt INTEGER DEFAULT 0,leaseUntil INTEGER DEFAULT 0",
        "id,owner,claimId,state,result,error,attempts,updated,txHash,nextAttempt,leaseUntil",
        "claimId IN (SELECT id FROM claims) AND owner IS NOT NULL AND state IS NOT NULL",
      ],
      [
        "draft_signatures",
        "draftId TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,claimId TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,PRIMARY KEY(draftId,claimId)",
        "draftId,claimId",
        "draftId IN (SELECT id FROM drafts) AND claimId IN (SELECT id FROM claims)",
      ],
    ]) {
      for (const row of db
        .prepare(
          `SELECT * FROM ${table} WHERE NOT (${predicate}) OR ${table === "jobs" ? "claimId IS NULL" : "draftId IS NULL OR claimId IS NULL"}`,
        )
        .all())
        db.prepare(
          "INSERT INTO migration_rejections(source,row_json,created) VALUES(?,?,?)",
        ).run(table, JSON.stringify(row), new Date().toISOString());
      db.exec(
        `CREATE TABLE ${table}_v3(${ddl});INSERT INTO ${table}_v3(${columns}) SELECT ${columns} FROM ${table} WHERE ${predicate};DROP TABLE ${table};ALTER TABLE ${table}_v3 RENAME TO ${table};`,
      );
    }
    db.exec(`CREATE INDEX audit_owner_id ON audit(owner,id);
INSERT INTO schema_migrations VALUES(3,datetime('now'));
PRAGMA user_version=3;COMMIT;`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw Error("FOREIGN_KEY_CHECK_FAILED");
  migrateReliability(db);
}
