import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Missing keys in existing stores require recovery, not fresh initialization.
export function loadStorageKey(root: string, configured?: string): Buffer {
  const file = resolve(root, "storage.key"),
    marker = resolve(root, "storage-key.id"),
    database = resolve(root, "contentproof.sqlite");
  const samples = ["objects", "exports"].map((folder) => {
    const dir = resolve(root, folder);
    const name = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).find(
          (f) => f.isFile() && !f.name.endsWith(".tmp"),
        )?.name
      : undefined;
    return name ? resolve(dir, name) : undefined;
  });
  if (!configured && !existsSync(file)) {
    if (existsSync(marker) || existsSync(database) || samples.some(Boolean))
      throw Error("STORAGE_KEY_MISSING_RECOVERY_REQUIRED");
    writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  const key = configured ? Buffer.from(configured, "hex") : readFileSync(file);
  if (key.length !== 32) throw Error("INVALID_STORAGE_KEY");
  const id = createHash("sha256").update(key).digest("hex");
  if (existsSync(marker)) {
    if (readFileSync(marker, "utf8").trim() !== id)
      throw Error("STORAGE_KEY_MISMATCH");
    return key;
  }
  // Authenticate legacy ciphertext before pinning a previously unmarked key.
  const authenticate = (bytes: Buffer) => {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.update(bytes.subarray(28));
    decipher.final();
  };
  try {
    if (existsSync(database)) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        for (const [table, column] of [
          ["drafts", "json"],
          ["claims", "encrypted"],
          ["exports", "input"],
        ]) {
          if (
            !db
              .prepare("SELECT name FROM sqlite_master WHERE name=?")
              .get(table)
          )
            continue;
          const row = db
            .prepare(`SELECT ${column} AS cipher FROM ${table} LIMIT 1`)
            .get();
          if (row) authenticate(Buffer.from(String(row.cipher), "base64"));
        }
      } finally {
        db.close();
      }
    }
    const magic = Buffer.from("CP-OBJECT-1\0");
    for (const sample of samples) {
      if (!sample) continue;
      const bytes = readFileSync(sample);
      if (bytes.subarray(0, magic.length).equals(magic))
        authenticate(bytes.subarray(magic.length));
    }
  } catch {
    throw Error("STORAGE_KEY_MISMATCH");
  }
  writeFileSync(marker, id, { mode: 0o600, flag: "wx" });
  return key;
}
