import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { vaultRequest } from "./vault-client.js";
import {
  readTransitEnvelope,
  decryptTransitEnvelope,
} from "./vault-transit.js";
export const vaultReferenceSchema = z.strictObject({
  version: z.literal(1),
  path: z
    .string()
    .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
    .max(1024),
  keyVersion: z.number().int().min(1).max(999999999),
});
export type VaultReference = z.infer<typeof vaultReferenceSchema>;
export function readVaultReference(file: string): VaultReference {
  try {
    if (!statSync(file).isFile() || statSync(file).size > 4096) throw Error();
    return vaultReferenceSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw Error("INVALID_VAULT_REFERENCE_FILE");
  }
}

// Resolve one explicit provider per key. Provisioning and rotation use separate
// maintenance actions; application startup never creates remote keys.
export async function loadConfiguredSecrets(
  env: NodeJS.ProcessEnv = process.env,
) {
  const resolved: Record<string, string> = {};
  for (const name of ["STORAGE_KEY", "RELAYER_PRIVATE_KEY"]) {
    const path = env[`${name}_VAULT_PATH`],
      file = env[`${name}_FILE`],
      referenceFile = env[`${name}_VAULT_REF_FILE`],
      transitFile = env[`${name}_VAULT_TRANSIT_FILE`];
    let value = env[name];
    if (
      transitFile &&
      (referenceFile || path || file || value || env[`${name}_VAULT_VERSION`])
    )
      throw Error(`AMBIGUOUS_${name}_PROVIDER`);
    if (
      referenceFile &&
      (path || file || value || env[`${name}_VAULT_VERSION`])
    )
      throw Error(`AMBIGUOUS_${name}_PROVIDER`);
    if (path && (file || value)) throw Error(`AMBIGUOUS_${name}_PROVIDER`);
    if (transitFile) {
      value = (
        await decryptTransitEnvelope(readTransitEnvelope(transitFile), env)
      ).toString("hex");
    } else if (referenceFile) {
      const reference = readVaultReference(referenceFile);
      value = await readVaultKey(
        reference.path,
        String(reference.keyVersion),
        env,
      );
    } else if (path)
      value = await readVaultKey(path, env[`${name}_VAULT_VERSION`], env);
    else if (file) {
      const fromFile = readFileSync(file, "utf8").trim();
      if (value && value.replace(/^0x/, "") !== fromFile.replace(/^0x/, ""))
        throw Error(`AMBIGUOUS_${name}_PROVIDER`);
      value = fromFile;
    }
    if (value) {
      if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(value))
        throw Error(`INVALID_${name}`);
      resolved[name] =
        name === "STORAGE_KEY"
          ? value.replace(/^0x/, "")
          : `0x${value.replace(/^0x/, "")}`;
    }
  }
  // Publish only after both keys succeed: a failed remote read cannot silently
  // fall back to generating a new local encryption key or development account.
  Object.assign(env, resolved);
  for (const name of Object.keys(resolved)) {
    if (env[`${name}_VAULT_PATH`]) {
      delete env[`${name}_VAULT_PATH`];
      delete env[`${name}_VAULT_VERSION`];
    }
    delete env[`${name}_VAULT_REF_FILE`];
    delete env[`${name}_VAULT_TRANSIT_FILE`];
  }
}

export async function readVaultKey(
  path: string,
  version: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (!/^[1-9][0-9]{0,8}$/.test(version ?? ""))
    throw Error("VAULT_KEY_VERSION_REQUIRED");
  const safePath = (value: string) =>
    value.split("/").every((part) => /^[A-Za-z0-9_-]+$/.test(part));
  const mount = env.VAULT_KV_MOUNT ?? "secret";
  if (!safePath(path) || !safePath(mount))
    throw Error("INVALID_VAULT_KEY_PATH");
  const body = await vaultRequest(
    `/v1/${mount}/data/${path}?version=${version}`,
    env,
  );
  const metadata = body?.data?.metadata,
    value = body?.data?.data?.key;
  if (
    metadata?.version !== Number(version) ||
    metadata?.destroyed !== false ||
    metadata?.deletion_time !== ""
  )
    throw Error("VAULT_VERSION_UNAVAILABLE");
  if (typeof value !== "string" || !/^(?:0x)?[a-fA-F0-9]{64}$/.test(value))
    throw Error("VAULT_INVALID_KEY");
  return value;
}
