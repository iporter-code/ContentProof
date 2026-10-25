import { it, expect, vi, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  provisionTransitEnvelope,
  rewrapTransitEnvelope,
} from "../packages/persistence/transit-envelope.js";
import {
  readTransitEnvelope,
  decryptTransitEnvelope,
} from "../packages/config/vault-transit.js";
import { vaultRequest } from "../packages/config/vault-client.js";
import { loadConfiguredSecrets } from "../packages/config/secrets.js";
afterEach(() => vi.unstubAllGlobals());
const dataKey = Buffer.alloc(32, 0xab);
function fixture() {
  mkdirSync("data/test-transit", { recursive: true });
  const root = mkdtempSync(resolve("data/test-transit/run-")),
    file = resolve(root, "key.envelope.json"),
    token = resolve(root, "token");
  writeFileSync(token, "synthetic-token");
  const env: NodeJS.ProcessEnv = {
    VAULT_ADDR: "https://vault.example",
    VAULT_TOKEN_FILE: token,
    VAULT_TRANSIT_KEY: "storage",
  };
  const envelope = {
    version: 1,
    provider: "vault-transit",
    address: "https://vault.example/",
    namespace: "",
    mount: "transit",
    key: "storage",
    ciphertext: "vault:v1:AAAA",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, options?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/keys/storage"))
        return new Response(
          JSON.stringify({
            data: { type: "aes256-gcm96", derived: false, exportable: false },
          }),
        );
      if (path.includes("/datakey/wrapped/"))
        return new Response(
          JSON.stringify({ data: { ciphertext: "vault:v1:AAAA" } }),
        );
      if (path.includes("/decrypt/"))
        return new Response(
          JSON.stringify({ data: { plaintext: dataKey.toString("base64") } }),
        );
      if (path.includes("/rewrap/"))
        return new Response(
          JSON.stringify({ data: { ciphertext: "vault:v2:BBBB" } }),
        );
      throw Error("Unexpected request");
    }),
  );
  return { root, file, env, envelope };
}
it("generates only a wrapped key, with no plaintext in the request or file", async () => {
  const f = fixture();
  expect((await provisionTransitEnvelope(f.file, f.env)).created).toBe(true);
  const text = readFileSync(f.file, "utf8");
  expect(text).not.toContain(dataKey.toString("hex"));
  expect(text).not.toContain("synthetic-token");
  const calls = vi.mocked(fetch).mock.calls;
  expect(calls.map(([url]) => String(url))).toEqual([
    "https://vault.example/v1/transit/keys/storage",
    "https://vault.example/v1/transit/datakey/wrapped/storage",
  ]);
  expect(JSON.parse(calls[1][1]?.body as string)).toEqual({ bits: 256 });
  const env: NodeJS.ProcessEnv = {
    ...f.env,
    STORAGE_KEY_VAULT_TRANSIT_FILE: f.file,
  };
  await loadConfiguredSecrets(env);
  expect(env.STORAGE_KEY).toBe(dataKey.toString("hex"));
  expect(env.STORAGE_KEY_VAULT_TRANSIT_FILE).toBeUndefined();
});
it("rewraps under a newer KEK, verifies the same data key and preserves old ciphertext", async () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify(f.envelope));
  const result = await rewrapTransitEnvelope(f.file, f.env);
  expect(result.fromVersion).toBe(1);
  expect(result.toVersion).toBe(2);
  expect(readTransitEnvelope(f.file).ciphertext).toBe("vault:v2:BBBB");
  expect(JSON.parse(readFileSync(result.backup, "utf8"))).toEqual(f.envelope);
  expect(
    await decryptTransitEnvelope(readTransitEnvelope(f.file), f.env),
  ).toEqual(dataKey);
});
it("refuses to rewrap when the decrypted data key changes", async () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify(f.envelope));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (
        String(args[0]).includes("/decrypt/") &&
        String(args[1]?.body).includes("v2")
      )
        return new Response(
          JSON.stringify({
            data: { plaintext: Buffer.alloc(32, 0xcd).toString("base64") },
          }),
        );
      return original(...args);
    }),
  );
  await expect(rewrapTransitEnvelope(f.file, f.env)).rejects.toThrow(
    "REWRAP_CHANGED_DATA_KEY",
  );
  expect(readTransitEnvelope(f.file)).toEqual(f.envelope);
});
it("requires a newer KEK version before replacing an envelope", async () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify(f.envelope));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: Parameters<typeof fetch>) =>
      String(args[0]).includes("/rewrap/")
        ? new Response(
            JSON.stringify({ data: { ciphertext: "vault:v1:BBBB" } }),
          )
        : original(...args),
    ),
  );
  await expect(rewrapTransitEnvelope(f.file, f.env)).rejects.toThrow(
    "NEW_KEK_VERSION_REQUIRED",
  );
  expect(readTransitEnvelope(f.file)).toEqual(f.envelope);
});
it.each([
  { type: "rsa-2048", derived: false, exportable: false },
  { type: "aes256-gcm96", derived: true, exportable: false },
  { type: "aes256-gcm96", derived: false, exportable: true },
])("rejects unsupported key custody configuration %j", async (info) => {
  const f = fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: info }))),
  );
  await expect(provisionTransitEnvelope(f.file, f.env)).rejects.toThrow(
    "UNSUPPORTED_KEY_CONFIGURATION",
  );
  expect(existsSync(f.file)).toBe(false);
});
it("binds the envelope to its address and namespace before transmitting ciphertext", async () => {
  const f = fixture();
  writeFileSync(
    f.file,
    JSON.stringify({ ...f.envelope, address: "https://other.example/" }),
  );
  await expect(
    decryptTransitEnvelope(readTransitEnvelope(f.file), f.env),
  ).rejects.toThrow("PROVIDER_MISMATCH");
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  "not-base64",
  Buffer.alloc(16).toString("base64"),
  Buffer.alloc(64).toString("base64"),
])("rejects malformed or wrong-size plaintext keys", async (plaintext) => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify(f.envelope));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: { plaintext } }))),
  );
  await expect(
    loadConfiguredSecrets({ ...f.env, STORAGE_KEY_VAULT_TRANSIT_FILE: f.file }),
  ).rejects.toThrow("INVALID_DATA_KEY");
});
it("an external envelope edit during rewrap is preserved and reported", async () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify(f.envelope));
  const original = vi.mocked(fetch).getMockImplementation()!;
  const edited = { ...f.envelope, ciphertext: "vault:v3:CCCC" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/rewrap/"))
        writeFileSync(f.file, JSON.stringify(edited));
      return original(...args);
    }),
  );
  await expect(rewrapTransitEnvelope(f.file, f.env)).rejects.toThrow(
    "ENVELOPE_CHANGED_OUTSIDE",
  );
  expect(readTransitEnvelope(f.file)).toEqual(edited);
});
it("rejects ambiguous selectors, existing output and path traversal without remote access", async () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify(f.envelope));
  await expect(provisionTransitEnvelope(f.file, f.env)).rejects.toThrow(
    "REQUIRES_NEW_FILE",
  );
  await expect(
    loadConfiguredSecrets({
      ...f.env,
      STORAGE_KEY: "11".repeat(32),
      STORAGE_KEY_VAULT_TRANSIT_FILE: f.file,
    }),
  ).rejects.toThrow("AMBIGUOUS");
  await expect(
    vaultRequest("//attacker.example/v1/decrypt", f.env, {}),
  ).rejects.toThrow("INVALID_VAULT_ENDPOINT");
  expect(fetch).not.toHaveBeenCalled();
});
