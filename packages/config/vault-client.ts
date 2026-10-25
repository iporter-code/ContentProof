import { readFileSync, statSync } from "node:fs";
const safePath = (value: string) =>
  value.split("/").every((part) => /^[A-Za-z0-9_-]+$/.test(part));
export function vaultConnection(env: NodeJS.ProcessEnv) {
  let url: URL;
  try {
    url = new URL(env.VAULT_ADDR ?? "");
  } catch {
    throw Error("INVALID_VAULT_ADDRESS");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw Error("INVALID_VAULT_ADDRESS");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw Error("VAULT_HTTPS_REQUIRED");
  const namespace = env.VAULT_NAMESPACE ?? "";
  if (namespace && !safePath(namespace)) throw Error("INVALID_VAULT_NAMESPACE");
  return { url, namespace };
}
export async function vaultRequest(
  endpoint: string,
  env: NodeJS.ProcessEnv,
  body?: Record<string, unknown>,
): Promise<any> {
  if (!/^\/v1\/[A-Za-z0-9_/-]+(?:\?[A-Za-z0-9_=&-]+)?$/.test(endpoint))
    throw Error("INVALID_VAULT_ENDPOINT");
  const { url, namespace } = vaultConnection(env);
  if (!env.VAULT_TOKEN_FILE) throw Error("VAULT_TOKEN_FILE_REQUIRED");
  if (statSync(env.VAULT_TOKEN_FILE).size > 8192)
    throw Error("INVALID_VAULT_TOKEN_FILE");
  const token = readFileSync(env.VAULT_TOKEN_FILE, "utf8").trim();
  if (!token || token.length > 4096 || /[\r\n]/.test(token))
    throw Error("INVALID_VAULT_TOKEN_FILE");
  try {
    const response = await fetch(new URL(endpoint, url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Vault-Token": token,
        ...(namespace ? { "X-Vault-Namespace": namespace } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Error(`VAULT_HTTP_${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > 65536)
      throw Error("VAULT_RESPONSE_TOO_LARGE");
    const reader = response.body?.getReader();
    if (!reader) throw Error("VAULT_EMPTY_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) throw Error("VAULT_RESPONSE_TOO_LARGE");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Error("VAULT_INVALID_RESPONSE");
    }
  } catch (error) {
    const message = (error as Error).message;
    throw Error(
      /^VAULT_[A-Z0-9_]+$/.test(message) ? message : "VAULT_REQUEST_FAILED",
    );
  }
}
