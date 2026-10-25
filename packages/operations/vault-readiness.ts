import { lstatSync } from "node:fs";
import { vaultConnection, vaultRequest } from "../config/vault-client.js";
export async function checkProductionVault(env: NodeJS.ProcessEnv) {
  const { url } = vaultConnection(env);
  if (url.protocol !== "https:" || env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw Error("PRODUCTION_VAULT_TLS_REQUIRED");
  if (!env.VAULT_TOKEN_FILE) throw Error("VAULT_TOKEN_FILE_REQUIRED");
  const stat = lstatSync(env.VAULT_TOKEN_FILE);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o007) !== 0)
  )
    throw Error("PRODUCTION_VAULT_TOKEN_PERMISSIONS");
  const identity = await vaultRequest("/v1/auth/token/lookup-self", env);
  const token = identity?.data;
  if (
    !Array.isArray(token?.policies) ||
    token.policies.includes("root") ||
    !(token.ttl > 0) ||
    !token.renewable
  )
    throw Error("PRODUCTION_VAULT_TOKEN_POLICY");
  const paths: string[] = [];
  if (
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(
      env.VAULT_KV_MOUNT ?? "secret",
    )
  )
    throw Error("PRODUCTION_VAULT_INVALID_MOUNT");
  for (const name of ["STORAGE_KEY", "RELAYER_PRIVATE_KEY"]) {
    const path = env[`${name}_VAULT_PATH`];
    if (!path) {
      if (name === "STORAGE_KEY")
        throw Error("PRODUCTION_VAULT_KV_CONFIGURATION_REQUIRED");
      continue;
    }
    if (
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path) ||
      !/^[1-9][0-9]{0,8}$/.test(env[`${name}_VAULT_VERSION`] ?? "")
    )
      throw Error("PRODUCTION_VAULT_EXACT_VERSION_REQUIRED");
    if (
      [
        env[name],
        env[`${name}_FILE`],
        env[`${name}_VAULT_REF_FILE`],
        env[`${name}_VAULT_TRANSIT_FILE`],
      ].some(Boolean)
    )
      throw Error("PRODUCTION_VAULT_AMBIGUOUS_PROVIDER");
    paths.push(`${env.VAULT_KV_MOUNT ?? "secret"}/data/${path}`);
  }
  const caps = await vaultRequest("/v1/sys/capabilities-self", env, { paths });
  for (const path of paths) {
    const allowed =
      caps?.data?.[path] ??
      caps?.[path] ??
      (paths.length === 1
        ? (caps?.data?.capabilities ?? caps?.capabilities)
        : undefined);
    if (
      !Array.isArray(allowed) ||
      !allowed.includes("read") ||
      allowed.some((v: string) =>
        [
          "root",
          "sudo",
          "create",
          "update",
          "delete",
          "patch",
          "deny",
        ].includes(v),
      )
    )
      throw Error("PRODUCTION_VAULT_EXCESS_OR_MISSING_CAPABILITY");
  }
  return {
    date: new Date().toISOString(),
    passed: true,
    https: true,
    nonRootRenewableToken: true,
    pinnedKvVersions: true,
    readOnlyKeyCapabilities: true,
    scope:
      "Live TLS/token/path-capability preflight for KV v2. Does not attest every policy path, actual key correctness, HA, backups, credential renewal over time or completed production cutover.",
  };
}
