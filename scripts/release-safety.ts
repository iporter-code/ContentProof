import { resolve } from "node:path";
const fileVariables = [
  "STORAGE_KEY_FILE",
  "RELAYER_PRIVATE_KEY_FILE",
  "STORAGE_KEY_VAULT_REF_FILE",
  "RELAYER_PRIVATE_KEY_VAULT_REF_FILE",
  "STORAGE_KEY_VAULT_TRANSIT_FILE",
  "RELAYER_PRIVATE_KEY_VAULT_TRANSIT_FILE",
  "VAULT_TOKEN_FILE",
];
export function assertPublicReleaseFile(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const fold = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const path = fold(resolve(file));
  for (const name of fileVariables) {
    const value = env[name];
    if (!value) continue;
    const secret = fold(resolve(value));
    if (path === secret || path.startsWith(secret + "."))
      throw Error("FORBIDDEN_RELEASE_SECRET_FILE");
  }
}
export function assertNoConfiguredSecret(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  for (const name of ["STORAGE_KEY", "RELAYER_PRIVATE_KEY", "VAULT_TOKEN"]) {
    const value = env[name];
    if (!value || value.length < 16) continue;
    if (/^(?:0x)?[a-fA-F0-9]{64}$/.test(value)) {
      if (text.toLowerCase().includes(value.replace(/^0x/, "").toLowerCase()))
        throw Error("FORBIDDEN_RELEASE_SECRET_CONTENT");
    } else if (text.includes(value))
      throw Error("FORBIDDEN_RELEASE_SECRET_CONTENT");
  }
}
