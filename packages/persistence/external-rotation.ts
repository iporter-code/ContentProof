import {
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { resolve, dirname, parse } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { acquireLock } from "./locks.js";
import { stageStorageRotation } from "./maintenance.js";
const hash = (key: Buffer) => createHash("sha256").update(key).digest("hex");
const journalSchema = z.strictObject({
  version: z.literal(1),
  source: z.string(),
  secret: z.string(),
  tag: z.string().regex(/^[a-f0-9]{16}$/),
  old: z.string().regex(/^[a-f0-9]{64}$/),
  next: z.string().regex(/^[a-f0-9]{64}$/),
  oldMarker: z.string().nullable(),
  records: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),
});
type Journal = z.infer<typeof journalSchema>;
export function noLinks(path: string) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw Error("ROTATION_SYMLINK_FORBIDDEN");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function secretKey(path: string) {
  noLinks(path);
  if (!lstatSync(path).isFile()) throw Error("INVALID_SECRET_FILE");
  const hex = readFileSync(path, "utf8").trim();
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw Error("INVALID_STORAGE_KEY_FILE");
  return Buffer.from(hex, "hex");
}
export function durable(path: string, bytes: string) {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function paths(j: Journal) {
  const source = resolve(j.source),
    secret = resolve(j.secret),
    fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (
    source === parse(source).root ||
    fold(secret) === fold(source) ||
    fold(secret).startsWith(
      fold(source) + (process.platform === "win32" ? "\\" : "/"),
    )
  )
    throw Error("SECRET_MUST_BE_OUTSIDE_DATA_DIRECTORY");
  return {
    source,
    secret,
    journal: `${source}.key-rotation.json`,
    stage: `${source}.rotate-external-${j.tag}`,
    rollback: `${source}.rollback-external-${j.tag}`,
    abandoned: `${source}.abandoned-${j.tag}`,
    keyStage: `${secret}.rotate-${j.tag}`,
    keyRollback: `${secret}.rollback-${j.tag}`,
    recoveryKey: `${secret}.recover-${j.tag}`,
  };
}
export function marker(root: string) {
  const file = resolve(root, "storage-key.id");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}
function load(source: string) {
  const file = `${resolve(source)}.key-rotation.json`;
  noLinks(file);
  if (lstatSync(file).size > 16384) throw Error("INVALID_ROTATION_JOURNAL");
  const j = journalSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (resolve(j.source) !== resolve(source))
    throw Error("ROTATION_SOURCE_MISMATCH");
  const p = paths(j);
  Object.values(p).forEach(noLinks);
  return { j, p };
}
// Preparation changes neither the active data directory nor the external secret.
// A durable journal blocks all new services until commit/rollback completes.
export function prepareExternalRotation(source: string, secret: string) {
  source = resolve(source);
  secret = resolve(secret);
  noLinks(source);
  noLinks(secret);
  const releaseControl = acquireLock(
      `${source}.rotation-control`,
      "maintenance",
    ),
    release = (() => {
      try {
        return acquireLock(source, "maintenance");
      } catch (e) {
        releaseControl();
        throw e;
      }
    })();
  try {
    const oldKey = secretKey(secret),
      nextKey = randomBytes(32),
      j: Journal = {
        version: 1,
        source,
        secret,
        tag: randomBytes(8).toString("hex"),
        old: hash(oldKey),
        next: hash(nextKey),
        oldMarker: marker(source),
        records: 0,
        objects: 0,
      },
      p = paths(j);
    Object.values(p).forEach(noLinks);
    // Exclusive files also preflight secret-directory writability before data work.
    durable(p.keyRollback, oldKey.toString("hex"));
    durable(p.keyStage, nextKey.toString("hex"));
    Object.assign(
      j,
      stageStorageRotation(source, p.stage, oldKey, nextKey, false),
    );
    durable(p.journal, JSON.stringify(j));
    return { records: j.records, objects: j.objects, pending: true };
  } finally {
    release();
    releaseControl();
  }
}
export function recoverExternalRotation(
  source: string,
  action: "commit" | "rollback",
) {
  source = resolve(source);
  const releaseControl = acquireLock(
      `${source}.rotation-control`,
      "maintenance",
    ),
    release = (() => {
      try {
        return existsSync(source)
          ? acquireLock(source, "maintenance", true)
          : () => {};
      } catch (e) {
        releaseControl();
        throw e;
      }
    })();
  try {
    const { j, p } = load(source),
      oldKey = secretKey(p.keyRollback);
    if (hash(oldKey) !== j.old) throw Error("ROTATION_BACKUP_KEY_MISMATCH");
    const current = existsSync(p.secret) ? hash(secretKey(p.secret)) : null;
    if (current !== null && current !== j.old && current !== j.next)
      throw Error("SECRET_CHANGED_OUTSIDE_ROTATION");
    const sourceExists = existsSync(p.source),
      sourceMarker = sourceExists ? marker(p.source) : undefined;
    if (sourceExists && sourceMarker !== j.oldMarker && sourceMarker !== j.next)
      throw Error("ROTATION_DATA_STATE_UNKNOWN");
    if (action === "commit") {
      const nextKey =
        current === j.next ? secretKey(p.secret) : secretKey(p.keyStage);
      if (hash(nextKey) !== j.next) throw Error("ROTATION_NEXT_KEY_MISMATCH");
      if (sourceMarker !== j.next) {
        if (!existsSync(p.stage) || marker(p.stage) !== j.next)
          throw Error("ROTATION_STAGE_MISSING");
        if (sourceExists) {
          if (existsSync(p.rollback)) throw Error("ROTATION_ROLLBACK_EXISTS");
          renameSync(p.source, p.rollback);
        }
        if (!existsSync(p.rollback) || marker(p.rollback) !== j.oldMarker)
          throw Error("ROTATION_ROLLBACK_MISSING");
        renameSync(p.stage, p.source);
      }
      if (!existsSync(p.rollback) || marker(p.rollback) !== j.oldMarker)
        throw Error("ROTATION_ROLLBACK_MISSING");
      if (current !== j.next) renameSync(p.keyStage, p.secret);
      if (hash(secretKey(p.secret)) !== j.next || marker(p.source) !== j.next)
        throw Error("ROTATION_COMMIT_INCOMPLETE");
    } else {
      if (sourceMarker === j.next) {
        if (
          !existsSync(p.rollback) ||
          existsSync(p.abandoned) ||
          marker(p.rollback) !== j.oldMarker
        )
          throw Error("ROTATION_ROLLBACK_UNSAFE");
        renameSync(p.source, p.abandoned);
        renameSync(p.rollback, p.source);
      } else if (!sourceExists) {
        if (!existsSync(p.rollback) || marker(p.rollback) !== j.oldMarker)
          throw Error("ROTATION_ROLLBACK_MISSING");
        renameSync(p.rollback, p.source);
      }
      if (current !== j.old) {
        if (existsSync(p.recoveryKey)) {
          if (hash(secretKey(p.recoveryKey)) !== j.old)
            throw Error("ROTATION_RECOVERY_KEY_MISMATCH");
        } else durable(p.recoveryKey, oldKey.toString("hex"));
        renameSync(p.recoveryKey, p.secret);
      }
      if (
        marker(p.source) !== j.oldMarker ||
        hash(secretKey(p.secret)) !== j.old
      )
        throw Error("ROTATION_ROLLBACK_INCOMPLETE");
    }
    // Only a fully matched key/data pair is allowed to unblock service startup.
    unlinkSync(p.journal);
    const oldLock = resolve(p.rollback, ".maintenance.lock");
    if (existsSync(oldLock)) unlinkSync(oldLock);
    return {
      action,
      records: j.records,
      objects: j.objects,
      rollback: existsSync(p.rollback) ? p.rollback : null,
      secretBackup: p.keyRollback,
    };
  } finally {
    release();
    releaseControl();
  }
}
export function rotateExternalStorage(source: string, secret: string) {
  prepareExternalRotation(source, secret);
  return recoverExternalRotation(source, "commit");
}
