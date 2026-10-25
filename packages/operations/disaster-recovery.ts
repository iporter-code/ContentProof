import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { restoreData } from "../persistence/maintenance.js";
const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
export function recoveryHostFingerprint() {
  // Retain only a digest, never the raw OS machine identifier.
  const identity =
    process.platform === "linux"
      ? readFileSync("/etc/machine-id", "utf8").trim()
      : hostname();
  if (!identity) throw Error("DR_HOST_ID_UNAVAILABLE");
  return sha(process.platform + ":" + identity);
}
const planSchema = z.strictObject({
  version: z.literal(1),
  created: z.string().datetime(),
  originHost: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.record(
    z.string().regex(/^(?:backup\.json|manifest\.enc|\d{8}\.enc)$/),
    z.strictObject({
      size: z
        .number()
        .int()
        .min(1)
        .max(20 * 1024 ** 3 + 28),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
async function encryptedInventory(folder: string) {
  const folderStat = lstatSync(folder);
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink())
    throw Error("DR_UNSAFE_BACKUP_DIRECTORY");
  const files: Record<string, { size: number; sha256: string }> = {};
  const entries = readdirSync(folder).sort();
  if (
    entries.length < 3 ||
    entries.length > 100002 ||
    !entries.includes("backup.json") ||
    !entries.includes("manifest.enc")
  )
    throw Error("DR_INCOMPLETE_BACKUP");
  for (const name of entries) {
    if (!/^(?:backup\.json|manifest\.enc|\d{8}\.enc)$/.test(name))
      throw Error("DR_UNEXPECTED_BACKUP_FILE");
    const path = resolve(folder, name),
      stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 1 ||
      stat.size > 20 * 1024 ** 3 + 28
    )
      throw Error("DR_UNSAFE_BACKUP_FILE");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    files[name] = { size: stat.size, sha256: hash.digest("hex") };
  }
  return files;
}
export async function prepareRecoveryPlan(
  backup: string,
  output: string,
  host = recoveryHostFingerprint(),
) {
  backup = resolve(backup);
  output = resolve(output);
  if (output.startsWith(backup + sep) || existsSync(output))
    throw Error("DR_PLAN_REQUIRES_NEW_EXTERNAL_FILE");
  const plan = planSchema.parse({
    version: 1,
    created: new Date().toISOString(),
    originHost: host,
    files: await encryptedInventory(backup),
  });
  writeFileSync(output, JSON.stringify(plan, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return { files: Object.keys(plan.files).length, originHost: host };
}
export async function restoreRecoveryPlan(
  planFile: string,
  backup: string,
  destination: string,
  passwordFile: string,
  host = recoveryHostFingerprint(),
) {
  const planStat = lstatSync(planFile);
  if (
    !planStat.isFile() ||
    planStat.isSymbolicLink() ||
    planStat.size > 24 * 1024 * 1024
  )
    throw Error("DR_PLAN_LIMIT");
  const plan = planSchema.parse(JSON.parse(readFileSync(planFile, "utf8")));
  if (plan.originHost === host) throw Error("DR_REQUIRES_DIFFERENT_HOST");
  if (existsSync(destination)) throw Error("RESTORE_REQUIRES_NEW_DIRECTORY");
  if (
    JSON.stringify(await encryptedInventory(backup)) !==
    JSON.stringify(plan.files)
  )
    throw Error("DR_BACKUP_HASH_MISMATCH");
  const stat = lstatSync(passwordFile);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 4096 ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw Error("DR_PASSWORD_FILE_PERMISSIONS");
  const start = performance.now();
  const result = await restoreData(
    backup,
    destination,
    readFileSync(passwordFile, "utf8").trim(),
  );
  return {
    date: new Date().toISOString(),
    passed: true,
    differentHost: true,
    originHost: plan.originHost,
    recoveryHost: host,
    planCreated: plan.created,
    restoredFiles: result.files,
    seconds: (performance.now() - start) / 1000,
    scope:
      "Encrypted transfer hashes, authenticated restoration and SQLite integrity. Host fingerprints depend on trusted OS identity and trusted source plan; API, chain startup and user business acceptance must be checked separately.",
  };
}
