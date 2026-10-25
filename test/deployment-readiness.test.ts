import { it, expect, afterEach, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { backupData } from "../packages/persistence/maintenance.js";
import {
  prepareRecoveryPlan,
  restoreRecoveryPlan,
} from "../packages/operations/disaster-recovery.js";
import { checkProductionVault } from "../packages/operations/vault-readiness.js";
afterEach(() => vi.unstubAllGlobals());
it("recovery preparation rejects same-host acceptance and detects changed encrypted transfer before writing a target", async () => {
  mkdirSync("data/test-readiness", { recursive: true });
  const root = mkdtempSync(resolve("data/test-readiness/dr-")),
    source = resolve(root, "source"),
    backup = resolve(root, "backup"),
    plan = resolve(root, "plan.json"),
    password = resolve(root, "password");
  mkdirSync(source);
  writeFileSync(resolve(source, "storage.key"), Buffer.alloc(32, 5));
  writeFileSync(resolve(source, "synthetic.txt"), "synthetic recovery bytes");
  writeFileSync(password, "synthetic-test-password-only", { mode: 0o600 });
  await backupData(source, backup, "synthetic-test-password-only");
  await prepareRecoveryPlan(backup, plan, "a".repeat(64));
  await expect(
    restoreRecoveryPlan(
      plan,
      backup,
      resolve(root, "same"),
      password,
      "a".repeat(64),
    ),
  ).rejects.toThrow("DR_REQUIRES_DIFFERENT_HOST");
  const target = resolve(root, "restored"),
    report = await restoreRecoveryPlan(
      plan,
      backup,
      target,
      password,
      "b".repeat(64),
    );
  expect(report.passed).toBe(true);
  expect(report.planCreated).toBe(
    JSON.parse(readFileSync(plan, "utf8")).created,
  );
  expect(readFileSync(resolve(target, "synthetic.txt"), "utf8")).toBe(
    "synthetic recovery bytes",
  );
  await expect(
    restoreRecoveryPlan(plan, backup, target, password, "b".repeat(64)),
  ).rejects.toThrow("RESTORE_REQUIRES_NEW_DIRECTORY");
  writeFileSync(resolve(backup, "00000000.enc"), "modified");
  await expect(
    restoreRecoveryPlan(
      plan,
      backup,
      resolve(root, "bad"),
      password,
      "b".repeat(64),
    ),
  ).rejects.toThrow("DR_BACKUP_HASH_MISMATCH");
  expect(existsSync(resolve(root, "bad"))).toBe(false);
});
it("production Vault preflight requires verified HTTPS, a non-root renewable token and read-only exact-version paths", async () => {
  mkdirSync("data/test-readiness", { recursive: true });
  const root = mkdtempSync(resolve("data/test-readiness/vault-")),
    token = resolve(root, "token");
  writeFileSync(token, "synthetic-test-token", { mode: 0o600 });
  const env = {
    VAULT_ADDR: "https://vault.example",
    VAULT_TOKEN_FILE: token,
    STORAGE_KEY_VAULT_PATH: "contentproof/storage",
    STORAGE_KEY_VAULT_VERSION: "1",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: URL) =>
        new Response(
          JSON.stringify(
            String(url).includes("lookup-self")
              ? {
                  data: {
                    policies: ["default", "contentproof-app"],
                    ttl: 600,
                    renewable: true,
                  },
                }
              : { data: { "secret/data/contentproof/storage": ["read"] } },
          ),
        ),
    ),
  );
  expect((await checkProductionVault(env)).passed).toBe(true);
  await expect(
    checkProductionVault({ ...env, VAULT_ADDR: "http://127.0.0.1:8200" }),
  ).rejects.toThrow("TLS_REQUIRED");
  await expect(
    checkProductionVault({ ...env, STORAGE_KEY_VAULT_VERSION: "latest" }),
  ).rejects.toThrow("EXACT_VERSION_REQUIRED");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { policies: ["root"], ttl: 600, renewable: true },
          }),
        ),
    ),
  );
  await expect(checkProductionVault(env)).rejects.toThrow("TOKEN_POLICY");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: URL) =>
        new Response(
          JSON.stringify(
            String(url).includes("lookup-self")
              ? { data: { policies: ["app"], ttl: 600, renewable: true } }
              : {
                  data: {
                    "secret/data/contentproof/storage": ["read", "update"],
                  },
                },
          ),
        ),
    ),
  );
  await expect(checkProductionVault(env)).rejects.toThrow(
    "EXCESS_OR_MISSING_CAPABILITY",
  );
});
