import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve, sep, parse } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  readVaultKey,
  readVaultReference,
  vaultReferenceSchema,
  type VaultReference,
} from "../config/secrets.js";
import { acquireLock } from "./locks.js";
import { stageStorageRotation } from "./maintenance.js";
import { noLinks, durable, marker } from "./external-rotation.js";

const hash = (key: Buffer) => createHash("sha256").update(key).digest("hex");
async function moveData(
  from: string,
  to: string,
  expectedMarker: string | null,
) {
  for (let attempt = 0; ; attempt++) {
    noLinks(from);
    noLinks(to);
    if (existsSync(to)) throw Error("ROTATION_DESTINATION_EXISTS");
    if (marker(from) !== expectedMarker)
      throw Error("ROTATION_DATA_STATE_UNKNOWN");
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (
        !["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        ) ||
        attempt >= 5
      )
        throw error;
      await new Promise((done) => setTimeout(done, 50 * (attempt + 1)));
    }
  }
}
const journalSchema = z.strictObject({
  version: z.literal(2),
  provider: z.literal("vault-kv2"),
  source: z.string(),
  referenceFile: z.string(),
  binding: z.strictObject({
    address: z.string(),
    mount: z.string(),
    namespace: z.string(),
  }),
  oldReference: vaultReferenceSchema,
  nextReference: vaultReferenceSchema,
  tag: z.string().regex(/^[a-f0-9]{16}$/),
  old: z.string().regex(/^[a-f0-9]{64}$/),
  next: z.string().regex(/^[a-f0-9]{64}$/),
  oldMarker: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  records: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),
});
type Journal = z.infer<typeof journalSchema>;
const same = (a: VaultReference, b: VaultReference) =>
  a.path === b.path && a.keyVersion === b.keyVersion;
const binding = (env: NodeJS.ProcessEnv) => ({
  address: env.VAULT_ADDR ?? "",
  mount: env.VAULT_KV_MOUNT ?? "secret",
  namespace: env.VAULT_NAMESPACE ?? "",
});
function paths(source: string, referenceFile: string, tag: string) {
  source = resolve(source);
  referenceFile = resolve(referenceFile);
  const fold = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  if (
    source === parse(source).root ||
    fold(referenceFile) === fold(source) ||
    fold(referenceFile).startsWith(fold(source) + sep)
  )
    throw Error("REFERENCE_MUST_BE_OUTSIDE_DATA_DIRECTORY");
  const result = {
    source,
    referenceFile,
    journal: `${source}.key-rotation.json`,
    stage: `${source}.rotate-vault-${tag}`,
    rollback: `${source}.rollback-vault-${tag}`,
    abandoned: `${source}.abandoned-vault-${tag}`,
    referenceStage: `${referenceFile}.rotate-${tag}`,
    referenceBackup: `${referenceFile}.rollback-${tag}`,
    commitReference: `${referenceFile}.recover-commit-${tag}`,
    rollbackReference: `${referenceFile}.recover-rollback-${tag}`,
  };
  Object.values(result).forEach(noLinks);
  return result;
}
function control(source: string, recover = false) {
  const releaseControl = acquireLock(
    `${source}.rotation-control`,
    "maintenance",
  );
  try {
    const release = existsSync(source)
      ? acquireLock(source, "maintenance", recover)
      : () => {};
    return () => {
      release();
      releaseControl();
    };
  } catch (error) {
    releaseControl();
    throw error;
  }
}
async function key(reference: VaultReference, env: NodeJS.ProcessEnv) {
  return Buffer.from(
    (
      await readVaultKey(reference.path, String(reference.keyVersion), env)
    ).replace(/^0x/, ""),
    "hex",
  );
}
function requireProvider(referenceFile: string, env: NodeJS.ProcessEnv) {
  if (
    env.STORAGE_KEY ||
    env.STORAGE_KEY_FILE ||
    env.STORAGE_KEY_VAULT_PATH ||
    env.STORAGE_KEY_VAULT_TRANSIT_FILE ||
    !env.STORAGE_KEY_VAULT_REF_FILE ||
    resolve(env.STORAGE_KEY_VAULT_REF_FILE) !== resolve(referenceFile)
  )
    throw Error("VAULT_ROTATION_REQUIRES_REFERENCE_PROVIDER");
}
function publishReference(
  p: ReturnType<typeof paths>,
  action: "commit" | "rollback",
  wanted: VaultReference,
  allowed: VaultReference[],
) {
  const current = existsSync(p.referenceFile)
    ? readVaultReference(p.referenceFile)
    : null;
  if (current && !allowed.some((reference) => same(current, reference)))
    throw Error("VAULT_REFERENCE_CHANGED_OUTSIDE_ROTATION");
  if (current && same(current, wanted)) return;
  const recovery =
    action === "commit" ? p.commitReference : p.rollbackReference;
  if (existsSync(recovery)) {
    if (!same(readVaultReference(recovery), wanted))
      throw Error("VAULT_RECOVERY_REFERENCE_MISMATCH");
  } else durable(recovery, JSON.stringify(wanted));
  renameSync(recovery, p.referenceFile);
}
/** No Vault write permission is required. New immutable key versions must have
 * been provisioned separately. Neither key bytes nor tokens enter the journal. */
export async function prepareVaultRotation(
  source: string,
  nextVersion: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  source = resolve(source);
  const referenceFile = env.STORAGE_KEY_VAULT_REF_FILE;
  if (!referenceFile) throw Error("VAULT_ROTATION_REQUIRES_REFERENCE_PROVIDER");
  requireProvider(referenceFile, env);
  noLinks(source);
  noLinks(referenceFile);
  if (!lstatSync(source).isDirectory()) throw Error("INVALID_ROTATION_SOURCE");
  const release = control(source);
  try {
    const tag = randomBytes(8).toString("hex"),
      p = paths(source, referenceFile, tag);
    const oldReference = readVaultReference(referenceFile),
      nextReference = vaultReferenceSchema.parse({
        ...oldReference,
        keyVersion: nextVersion,
      });
    if (nextVersion <= oldReference.keyVersion)
      throw Error("VAULT_NEXT_VERSION_MUST_INCREASE");
    const oldKey = await key(oldReference, env),
      nextKey = await key(nextReference, env);
    if (oldKey.equals(nextKey))
      throw Error("VAULT_ROTATION_REQUIRES_DISTINCT_KEYS");
    const j: Journal = {
      version: 2,
      provider: "vault-kv2",
      source,
      referenceFile: resolve(referenceFile),
      binding: binding(env),
      oldReference,
      nextReference,
      tag,
      old: hash(oldKey),
      next: hash(nextKey),
      oldMarker: marker(source),
      records: 0,
      objects: 0,
    };
    durable(p.referenceBackup, JSON.stringify(oldReference));
    durable(p.referenceStage, JSON.stringify(nextReference));
    Object.assign(
      j,
      stageStorageRotation(source, p.stage, oldKey, nextKey, false),
    );
    durable(p.journal, JSON.stringify(j));
    return {
      provider: j.provider,
      records: j.records,
      objects: j.objects,
      pending: true,
      fromVersion: oldReference.keyVersion,
      toVersion: nextVersion,
    };
  } finally {
    release();
  }
}
export async function recoverVaultRotation(
  source: string,
  action: "commit" | "rollback",
  env: NodeJS.ProcessEnv = process.env,
) {
  if (action !== "commit" && action !== "rollback")
    throw Error("INVALID_ROTATION_RECOVERY_ACTION");
  source = resolve(source);
  noLinks(source);
  const release = control(source, true);
  try {
    const journal = `${source}.key-rotation.json`;
    noLinks(journal);
    if (!lstatSync(journal).isFile() || lstatSync(journal).size > 16384)
      throw Error("INVALID_ROTATION_JOURNAL");
    const j = journalSchema.parse(JSON.parse(readFileSync(journal, "utf8")));
    if (resolve(j.source) !== source) throw Error("ROTATION_SOURCE_MISMATCH");
    if (
      j.old === j.next ||
      j.oldReference.path !== j.nextReference.path ||
      j.oldReference.keyVersion >= j.nextReference.keyVersion ||
      (j.oldMarker !== null && j.oldMarker !== j.old)
    )
      throw Error("INVALID_ROTATION_JOURNAL");
    requireProvider(j.referenceFile, env);
    if (JSON.stringify(j.binding) !== JSON.stringify(binding(env)))
      throw Error("VAULT_PROVIDER_CHANGED_DURING_ROTATION");
    const p = paths(source, j.referenceFile, j.tag);
    if (!same(readVaultReference(p.referenceBackup), j.oldReference))
      throw Error("VAULT_REFERENCE_BACKUP_MISMATCH");
    const current = existsSync(p.referenceFile)
      ? readVaultReference(p.referenceFile)
      : null;
    if (
      current &&
      !same(current, j.oldReference) &&
      !same(current, j.nextReference)
    )
      throw Error("VAULT_REFERENCE_CHANGED_OUTSIDE_ROTATION");
    if (hash(await key(j.oldReference, env)) !== j.old)
      throw Error("VAULT_OLD_KEY_CHANGED");
    if (action === "commit" && hash(await key(j.nextReference, env)) !== j.next)
      throw Error("VAULT_NEXT_KEY_CHANGED");
    const freshReference = existsSync(p.referenceFile)
      ? readVaultReference(p.referenceFile)
      : null;
    if (
      freshReference &&
      !same(freshReference, j.oldReference) &&
      !same(freshReference, j.nextReference)
    )
      throw Error("VAULT_REFERENCE_CHANGED_OUTSIDE_ROTATION");
    const sourceExists = existsSync(source),
      sourceMarker = sourceExists ? marker(source) : undefined;
    if (sourceExists && sourceMarker !== j.oldMarker && sourceMarker !== j.next)
      throw Error("ROTATION_DATA_STATE_UNKNOWN");
    if (action === "commit") {
      if (sourceMarker !== j.next) {
        if (!existsSync(p.stage) || marker(p.stage) !== j.next)
          throw Error("ROTATION_STAGE_MISSING");
        if (sourceExists) {
          if (existsSync(p.rollback)) throw Error("ROTATION_ROLLBACK_EXISTS");
          await moveData(source, p.rollback, j.oldMarker);
        }
        if (!existsSync(p.rollback) || marker(p.rollback) !== j.oldMarker)
          throw Error("ROTATION_ROLLBACK_MISSING");
        await moveData(p.stage, source, j.next);
      }
      if (!existsSync(p.rollback) || marker(p.rollback) !== j.oldMarker)
        throw Error("ROTATION_ROLLBACK_MISSING");
      publishReference(p, "commit", j.nextReference, [
        j.oldReference,
        j.nextReference,
      ]);
    } else {
      if (sourceMarker === j.next) {
        if (
          !existsSync(p.rollback) ||
          marker(p.rollback) !== j.oldMarker ||
          existsSync(p.abandoned)
        )
          throw Error("ROTATION_ROLLBACK_UNSAFE");
        await moveData(source, p.abandoned, j.next);
        await moveData(p.rollback, source, j.oldMarker);
      } else if (!sourceExists) {
        if (!existsSync(p.rollback) || marker(p.rollback) !== j.oldMarker)
          throw Error("ROTATION_ROLLBACK_MISSING");
        await moveData(p.rollback, source, j.oldMarker);
      }
      publishReference(p, "rollback", j.oldReference, [
        j.oldReference,
        j.nextReference,
      ]);
    }
    const wanted = action === "commit" ? j.nextReference : j.oldReference;
    if (
      marker(source) !== (action === "commit" ? j.next : j.oldMarker) ||
      !same(readVaultReference(p.referenceFile), wanted)
    )
      throw Error("VAULT_ROTATION_RECOVERY_INCOMPLETE");
    unlinkSync(journal);
    const oldLock = resolve(p.rollback, ".maintenance.lock");
    if (existsSync(oldLock)) unlinkSync(oldLock);
    return {
      action,
      provider: j.provider,
      records: j.records,
      objects: j.objects,
      activeVersion: wanted.keyVersion,
      rollback: existsSync(p.rollback) ? p.rollback : null,
      referenceBackup: p.referenceBackup,
    };
  } finally {
    release();
  }
}
export async function rotateVaultStorage(
  source: string,
  nextVersion: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  await prepareVaultRotation(source, nextVersion, env);
  return recoverVaultRotation(source, "commit", env);
}
