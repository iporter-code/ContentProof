import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  cpSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import { resolve, relative, sep, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireLock } from "./locks.js";
import { publishRestore } from "./restore-publish.js";
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const seal = (b: Uint8Array, k: Buffer) => {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", k, iv);
  const out = Buffer.concat([c.update(b), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]);
};
const open = (b: Buffer, k: Buffer) => {
  const d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
};
function inside(root: string, path: string) {
  const full = resolve(root, path);
  if (full === root || !full.startsWith(root + sep))
    throw Error("UNSAFE_BACKUP_PATH");
  return full;
}
function files(root: string, current = root): string[] {
  return readdirSync(current).flatMap((name) => {
    const p = resolve(current, name),
      s = lstatSync(p);
    if (s.isSymbolicLink()) throw Error("SYMLINK_NOT_SUPPORTED");
    if (/^\.(?:api|chain|maintenance)\.lock$/.test(name)) return [];
    return s.isDirectory()
      ? files(root, p)
      : [relative(root, p).split(sep).join("/")];
  });
}
function checkpoint(root: string) {
  const p = resolve(root, "contentproof.sqlite");
  if (existsSync(p)) {
    const db = new DatabaseSync(p);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      if (
        (db.prepare("PRAGMA integrity_check").get() as any).integrity_check !==
        "ok"
      )
        throw Error("DATABASE_INTEGRITY_FAILED");
    } finally {
      db.close();
    }
  }
}
function key(password: string, salt: Buffer) {
  if (password.length < 16) throw Error("BACKUP_PASSWORD_MIN_16");
  return scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}
export async function backupData(
  source: string,
  destination: string,
  password: string,
  externalKey?: Buffer,
) {
  source = resolve(source);
  destination = resolve(destination);
  if (
    destination === source ||
    destination.startsWith(source + sep) ||
    existsSync(destination)
  )
    throw Error("BACKUP_REQUIRES_NEW_EXTERNAL_DIRECTORY");
  const release = acquireLock(source, "maintenance");
  try {
    checkpoint(source);
    files(source); // Reject symlinks before copying or rewriting any object.
    const storageKey =
      externalKey ?? readFileSync(resolve(source, "storage.key"));
    if (storageKey.length !== 32) throw Error("INVALID_STORAGE_KEY");
    const salt = randomBytes(16),
      k = key(password, salt);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const rows: { path: string; id: string; size: number; sha256: string }[] =
      [];
    for (const path of [
      ...files(source).filter((p) => p !== "storage.key"),
      "storage.key",
    ]) {
      const input = inside(source, path),
        id = String(rows.length).padStart(8, "0"),
        iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", k, iv),
        h = createHash("sha256");
      const output = resolve(destination, `${id}.enc`);
      writeFileSync(output, iv, { flag: "wx", mode: 0o600 });
      await pipeline(
        path === "storage.key"
          ? Readable.from([storageKey])
          : createReadStream(input),
        new Transform({
          transform(chunk, _, cb) {
            h.update(chunk);
            cb(null, chunk);
          },
        }),
        c,
        createWriteStream(output, { flags: "a" }),
      );
      writeFileSync(output, c.getAuthTag(), { flag: "a" });
      rows.push({
        path,
        id,
        size: path === "storage.key" ? 32 : statSync(input).size,
        sha256: h.digest("hex"),
      });
    }
    // The manifest and paths are authenticated and encrypted; a completion marker
    // is written only after every file is safely closed.
    writeFileSync(
      resolve(destination, "manifest.enc"),
      seal(
        Buffer.from(
          JSON.stringify({
            version: 1,
            created: new Date().toISOString(),
            files: rows,
          }),
        ),
        k,
      ),
      { flag: "wx", mode: 0o600 },
    );
    writeFileSync(
      resolve(destination, "backup.json"),
      JSON.stringify({ version: 1, salt: salt.toString("hex") }),
      { flag: "wx", mode: 0o600 },
    );
    return { files: rows.length, bytes: rows.reduce((n, r) => n + r.size, 0) };
  } finally {
    release();
  }
}
export async function restoreData(
  source: string,
  destination: string,
  password: string,
) {
  source = resolve(source);
  destination = resolve(destination);
  if (existsSync(destination)) throw Error("RESTORE_REQUIRES_NEW_DIRECTORY");
  const header = JSON.parse(
    readFileSync(resolve(source, "backup.json"), "utf8"),
  );
  if (header.version !== 1 || !/^[a-f0-9]{32}$/.test(header.salt))
    throw Error("INVALID_BACKUP");
  const k = key(password, Buffer.from(header.salt, "hex"));
  const encoded = readFileSync(resolve(source, "manifest.enc"));
  if (encoded.length > 16 * 1024 * 1024) throw Error("MANIFEST_LIMIT");
  const manifest = JSON.parse(open(encoded, k).toString("utf8"));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 100000
  )
    throw Error("INVALID_BACKUP");
  const seen = new Set<string>();
  for (const r of manifest.files) {
    if (
      typeof r.path !== "string" ||
      /[<>:"|?*\u0000-\u001f]/.test(r.path) ||
      r.path.split("/").some((part: string) => /[. ]$/.test(part)) ||
      r.path.includes("\\") ||
      r.path.split("/").some((x: string) => !x || x === ".." || x === ".") ||
      !/^\d{8}$/.test(r.id) ||
      !Number.isSafeInteger(r.size) ||
      r.size < 0 ||
      r.size > 20 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(r.sha256)
    )
      throw Error("INVALID_BACKUP_ENTRY");
    const target = inside(destination, r.path).toLowerCase();
    if (seen.has(target)) throw Error("DUPLICATE_BACKUP_PATH");
    seen.add(target);
  }
  const stage = `${destination}.restore-${randomBytes(8).toString("hex")}`;
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  for (const r of manifest.files) {
    const input = resolve(source, `${r.id}.enc`),
      size = statSync(input).size;
    if (size !== r.size + 28) throw Error("BACKUP_SIZE_MISMATCH");
    const { open: fsOpen } = await import("node:fs/promises"),
      handle = await fsOpen(input, "r"),
      iv = Buffer.alloc(12),
      tag = Buffer.alloc(16);
    try {
      await handle.read(iv, 0, 12, 0);
      await handle.read(tag, 0, 16, size - 16);
    } finally {
      await handle.close();
    }
    const d = createDecipheriv("aes-256-gcm", k, iv);
    d.setAuthTag(tag);
    const h = createHash("sha256"),
      output = inside(stage, r.path);
    mkdirSync(dirname(output), { recursive: true });
    if (r.size === 0) {
      d.final();
      writeFileSync(output, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    } else
      await pipeline(
        createReadStream(input, { start: 12, end: size - 17 }),
        d,
        new Transform({
          transform(chunk, _, cb) {
            h.update(chunk);
            cb(null, chunk);
          },
        }),
        createWriteStream(output, { flags: "wx", mode: 0o600 }),
      );
    if (h.digest("hex") !== r.sha256) throw Error("BACKUP_HASH_MISMATCH");
  }
  checkpoint(stage);
  await publishRestore(stage, destination);
  return { files: manifest.files.length };
}
export function stageStorageRotation(
  source: string,
  stage: string,
  oldKey: Buffer,
  next: Buffer,
  localKey = true,
) {
  source = resolve(source);
  stage = resolve(stage);
  if (existsSync(stage) || stage === source || stage.startsWith(source + sep))
    throw Error("ROTATION_REQUIRES_NEW_EXTERNAL_STAGE");
  if (oldKey.length !== 32 || next.length !== 32)
    throw Error("INVALID_STORAGE_KEY");
  const marker = resolve(source, "storage-key.id");
  if (
    existsSync(marker) &&
    readFileSync(marker, "utf8").trim() !== digest(oldKey)
  )
    throw Error("STORAGE_KEY_MISMATCH");
  checkpoint(source);
  files(source);
  cpSync(source, stage, {
    recursive: true,
    filter: (p) =>
      !/^\.(?:api|chain|maintenance)\.lock$/.test(p.split(sep).at(-1)!),
  });
  const db = new DatabaseSync(resolve(stage, "contentproof.sqlite"));
  let records = 0,
    objects = 0;
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const [table, column] of [
      ["claims", "encrypted"],
      ["drafts", "json"],
      ["exports", "input"],
    ]) {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table))
        continue;
      for (const row of db
        .prepare(`SELECT id,${column} AS cipher FROM ${table}`)
        .all() as any[]) {
        const plain = open(Buffer.from(row.cipher, "base64"), oldKey);
        db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(
          seal(plain, next).toString("base64"),
          row.id,
        );
        records++;
      }
    }
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const magic = Buffer.from("CP-OBJECT-1\0"),
    objectRoot = resolve(stage, "objects");
  if (existsSync(objectRoot))
    for (const name of readdirSync(objectRoot)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const p = inside(objectRoot, name),
        b = readFileSync(p),
        plain = b.subarray(0, magic.length).equals(magic)
          ? open(b.subarray(magic.length), oldKey)
          : b;
      if (digest(plain) !== name) throw Error("OBJECT_HASH_MISMATCH");
      writeFileSync(p, Buffer.concat([magic, seal(plain, next)]), {
        mode: 0o600,
      });
      objects++;
    }
  // Export output is ephemeral and may contain private data. Invalidate it on
  // rotation instead of carrying plaintext exports into the new key epoch.
  const exportsRoot = resolve(stage, "exports");
  if (existsSync(exportsRoot))
    for (const name of readdirSync(exportsRoot))
      if (/^[a-f0-9-]+\.(?:zip|cpe)(?:\.[a-f0-9-]+\.tmp)?$/.test(name))
        unlinkSync(inside(exportsRoot, name));
  const state = new DatabaseSync(resolve(stage, "contentproof.sqlite"));
  try {
    if (
      state.prepare("SELECT name FROM sqlite_master WHERE name='exports'").get()
    )
      state.exec("UPDATE exports SET state='expired',lease=NULL,leaseUntil=0");
  } finally {
    state.close();
  }
  if (localKey)
    writeFileSync(resolve(stage, "storage.key"), next, { mode: 0o600 });
  else if (existsSync(resolve(stage, "storage.key")))
    unlinkSync(resolve(stage, "storage.key"));
  writeFileSync(resolve(stage, "storage-key.id"), digest(next), {
    mode: 0o600,
  });
  return { records, objects };
}
export function rotateStorage(source: string) {
  source = resolve(source);
  if (
    process.env.STORAGE_KEY ||
    process.env.STORAGE_KEY_FILE ||
    process.env.STORAGE_KEY_VAULT_PATH ||
    process.env.STORAGE_KEY_VAULT_REF_FILE ||
    process.env.STORAGE_KEY_VAULT_TRANSIT_FILE
  )
    throw Error("ROTATION_REQUIRES_FILE_KEY_MODE");
  const release = acquireLock(source, "maintenance"),
    suffix = randomBytes(8).toString("hex"),
    stage = `${source}.rotate-${suffix}`,
    rollback = `${source}.rollback-${suffix}`;
  try {
    const result = stageStorageRotation(
      source,
      stage,
      readFileSync(resolve(source, "storage.key")),
      randomBytes(32),
    );
    renameSync(source, rollback);
    try {
      renameSync(stage, source);
    } catch (error) {
      renameSync(rollback, source);
      throw error;
    }
    // Keep the original intact as an explicit rollback copy; never delete it.
    const oldLock = resolve(rollback, ".maintenance.lock");
    if (existsSync(oldLock)) unlinkSync(oldLock);
    return { ...result, rollback };
  } finally {
    release();
  }
}
export function collectOrphans(source: string, apply = false) {
  source = resolve(source);
  const release = acquireLock(source, "maintenance");
  try {
    checkpoint(source);
    const db = new DatabaseSync(resolve(source, "contentproof.sqlite"));
    let known: Set<string>;
    try {
      known = new Set(
        (db.prepare("SELECT digest FROM assets").all() as any[]).map((r) =>
          r.digest.slice(2),
        ),
      );
    } finally {
      db.close();
    }
    const root = resolve(source, "objects"),
      candidates = existsSync(root)
        ? readdirSync(root).filter(
            (name) =>
              (/^[a-f0-9]{64}$/.test(name) && !known.has(name)) ||
              /^[a-f0-9]{64}\.[a-f0-9-]+\.tmp$/.test(name),
          )
        : [];
    for (const name of candidates)
      if (apply) {
        const p = inside(root, name);
        if (!lstatSync(p).isFile() || lstatSync(p).isSymbolicLink())
          throw Error("UNSAFE_ORPHAN");
        unlinkSync(p);
      }
    return { apply, candidates };
  } finally {
    release();
  }
}
