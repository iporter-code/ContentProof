import {
  backupData,
  restoreData,
  rotateStorage,
  collectOrphans,
} from "../packages/persistence/maintenance.js";
import { dataPath } from "../packages/config/index.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfiguredSecrets } from "../packages/config/secrets.js";
import {
  rotateExternalStorage,
  recoverExternalRotation,
} from "../packages/persistence/external-rotation.js";
import {
  prepareVaultRotation,
  recoverVaultRotation,
  rotateVaultStorage,
} from "../packages/persistence/vault-rotation.js";
import {
  provisionTransitEnvelope,
  rewrapTransitEnvelope,
} from "../packages/persistence/transit-envelope.js";
const [command, target] = process.argv.slice(2);
try {
  let result;
  if (command === "backup" && target) {
    await loadConfiguredSecrets();
    const hex =
      process.env.STORAGE_KEY ??
      (process.env.STORAGE_KEY_FILE
        ? readFileSync(process.env.STORAGE_KEY_FILE, "utf8").trim()
        : undefined);
    if (hex && !/^[a-fA-F0-9]{64}$/.test(hex))
      throw Error("INVALID_STORAGE_KEY");
    result = await backupData(
      dataPath,
      target,
      process.env.CP_BACKUP_PASSWORD ?? "",
      hex ? Buffer.from(hex, "hex") : undefined,
    );
  } else if (command === "restore" && target)
    result = await restoreData(
      target,
      dataPath,
      process.env.CP_BACKUP_PASSWORD ?? "",
    );
  else if (command === "rotate") result = rotateStorage(dataPath);
  else if (
    command === "rotate-external" &&
    process.env.STORAGE_KEY_FILE &&
    !process.env.STORAGE_KEY_VAULT_REF_FILE &&
    !process.env.STORAGE_KEY_VAULT_TRANSIT_FILE &&
    !process.env.STORAGE_KEY_VAULT_PATH
  )
    result = rotateExternalStorage(dataPath, process.env.STORAGE_KEY_FILE);
  else if (command === "prepare-vault" && target)
    result = await prepareVaultRotation(dataPath, Number(target));
  else if (command === "rotate-vault" && target)
    result = await rotateVaultStorage(dataPath, Number(target));
  else if (
    command === "recover-vault" &&
    (target === "commit" || target === "rollback")
  )
    result = await recoverVaultRotation(dataPath, target);
  else if (command === "init-transit" && target) {
    if (
      ["contentproof.sqlite", "storage.key", "storage-key.id"].some((file) =>
        existsSync(resolve(dataPath, file)),
      )
    )
      throw Error("TRANSIT_INITIALIZATION_REQUIRES_NEW_DATA_DIRECTORY");
    result = await provisionTransitEnvelope(target);
  } else if (
    command === "rewrap-transit" &&
    process.env.STORAGE_KEY_VAULT_TRANSIT_FILE
  )
    result = await rewrapTransitEnvelope(
      process.env.STORAGE_KEY_VAULT_TRANSIT_FILE,
    );
  else if (
    command === "recover-key" &&
    (target === "commit" || target === "rollback")
  )
    result = recoverExternalRotation(dataPath, target);
  else if (command === "gc")
    result = collectOrphans(dataPath, process.argv.includes("--apply"));
  else
    throw Error(
      "USAGE: maintenance backup <new-dir> | restore <backup-dir> | rotate | rotate-external (STORAGE_KEY_FILE) | recover-key commit|rollback | prepare-vault <version> | rotate-vault <version> | recover-vault commit|rollback | init-transit <new-file> | rewrap-transit | gc [--apply]",
    );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : "MAINTENANCE_FAILED");
  process.exitCode = 1;
}
