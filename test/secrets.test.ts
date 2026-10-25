import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfiguredSecrets } from "../packages/config/secrets.js";
let dir: string, env: NodeJS.ProcessEnv;
const secret = "ab".repeat(32);
const good = () => ({
  data: {
    data: { key: secret },
    metadata: { version: 3, destroyed: false, deletion_time: "" },
  },
});
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "cp-vault-test-"));
  writeFileSync(resolve(dir, "token"), "synthetic-token", { mode: 0o600 });
  env = {
    VAULT_ADDR: "https://vault.example",
    VAULT_TOKEN_FILE: resolve(dir, "token"),
    STORAGE_KEY_VAULT_PATH: "contentproof/storage",
    STORAGE_KEY_VAULT_VERSION: "3",
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});
const mock = (body: unknown = good(), status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
it("pins the exact KV v2 version, authenticates and normalizes the key", async () => {
  mock();
  env.VAULT_NAMESPACE = "institution/team";
  await loadConfiguredSecrets(env);
  expect(env.STORAGE_KEY).toBe(secret);
  expect(env.STORAGE_KEY_VAULT_PATH).toBeUndefined();
  const [url, options] = vi.mocked(fetch).mock.calls[0];
  expect(String(url)).toBe(
    "https://vault.example/v1/secret/data/contentproof/storage?version=3",
  );
  expect(options?.headers).toEqual({
    "X-Vault-Token": "synthetic-token",
    "X-Vault-Namespace": "institution/team",
  });
  expect(options?.redirect).toBe("error");
  await loadConfiguredSecrets(env);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  "http://vault.example",
  "file:///tmp/key",
  "https://user:password@vault.example",
  "https://vault.example/path",
  "https://vault.example/?token=x",
])("rejects unsafe Vault address %s", async (address) => {
  mock();
  env.VAULT_ADDR = address;
  await expect(loadConfiguredSecrets(env)).rejects.toThrow(/VAULT_/);
  expect(fetch).not.toHaveBeenCalled();
  expect(env.STORAGE_KEY).toBeUndefined();
});
it.each([undefined, "0", "latest", "3&foo=1"])(
  "requires an explicit valid key version %s",
  async (version) => {
    mock();
    env.STORAGE_KEY_VAULT_VERSION = version;
    await expect(loadConfiguredSecrets(env)).rejects.toThrow(
      "VAULT_KEY_VERSION_REQUIRED",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each(["../storage", "storage?version=1", "storage//key", "%2e%2e/key"])(
  "rejects path traversal %s",
  async (path) => {
    mock();
    env.STORAGE_KEY_VAULT_PATH = path;
    await expect(loadConfiguredSecrets(env)).rejects.toThrow(
      "INVALID_VAULT_KEY_PATH",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([403, 404, 429, 503])(
  "fails closed and never echoes remote error bodies (%d)",
  async (status) => {
    mock({ errors: ["sensitive remote details"] }, status);
    await expect(loadConfiguredSecrets(env)).rejects.toThrow(
      `VAULT_HTTP_${status}`,
    );
    expect(env.STORAGE_KEY).toBeUndefined();
    expect(env.STORAGE_KEY_VAULT_PATH).toBeDefined();
  },
);
it.each([
  { version: 4, destroyed: false, deletion_time: "" },
  { version: 3, destroyed: true, deletion_time: "" },
  { version: 3, destroyed: false, deletion_time: "2026-01-01" },
])("rejects a mismatched/deleted version %j", async (metadata) => {
  mock({ data: { data: { key: secret }, metadata } });
  await expect(loadConfiguredSecrets(env)).rejects.toThrow(
    "VAULT_VERSION_UNAVAILABLE",
  );
  expect(env.STORAGE_KEY).toBeUndefined();
});
it("does not publish the first key when reading the second key fails", async () => {
  env.RELAYER_PRIVATE_KEY_VAULT_PATH = "contentproof/relayer";
  env.RELAYER_PRIVATE_KEY_VAULT_VERSION = "3";
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(good())))
      .mockResolvedValueOnce(new Response("no", { status: 403 })),
  );
  await expect(loadConfiguredSecrets(env)).rejects.toThrow("VAULT_HTTP_403");
  expect(env.STORAGE_KEY).toBeUndefined();
  expect(env.RELAYER_PRIVATE_KEY).toBeUndefined();
});
it("rejects competing providers and malformed remote key material", async () => {
  mock();
  env.STORAGE_KEY = secret;
  await expect(loadConfiguredSecrets(env)).rejects.toThrow(
    "AMBIGUOUS_STORAGE_KEY_PROVIDER",
  );
  delete env.STORAGE_KEY;
  mock({ data: { data: { key: "no" }, metadata: good().data.metadata } });
  await expect(loadConfiguredSecrets(env)).rejects.toThrow("VAULT_INVALID_KEY");
});
it("caps a streamed response without trusting its Content-Length", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("x".repeat(65537))),
  );
  await expect(loadConfiguredSecrets(env)).rejects.toThrow(
    "VAULT_RESPONSE_TOO_LARGE",
  );
});
it("does not expose token-containing network errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw Error("synthetic-token");
    }),
  );
  await expect(loadConfiguredSecrets(env)).rejects.toThrow(
    /^VAULT_REQUEST_FAILED$/,
  );
});
it("preserves compatible file providers and rejects conflicting values", async () => {
  const file = resolve(dir, "key");
  writeFileSync(file, "0x" + secret);
  const local = { STORAGE_KEY_FILE: file, STORAGE_KEY: secret };
  await loadConfiguredSecrets(local);
  expect(local.STORAGE_KEY).toBe(secret);
  local.STORAGE_KEY = "cd".repeat(32);
  await expect(loadConfiguredSecrets(local)).rejects.toThrow(
    "AMBIGUOUS_STORAGE_KEY_PROVIDER",
  );
});
