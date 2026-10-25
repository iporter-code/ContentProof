import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// The deployment helper is also executable by the bundled Node runtime.
// @ts-expect-error JavaScript deployment helper has no separate declaration file.
import { initializeCloudConfig } from "../deploy/cloud/config.mjs";
it("cloud upgrades preserve closed registration, reviewers and custom key/RPC providers byte for byte", () => {
  mkdirSync("data/test-cloud-config", { recursive: true });
  const root = mkdtempSync(resolve("data/test-cloud-config/run-")),
    path = resolve(root, "app.env");
  expect(initializeCloudConfig(path, "203.0.113.10").created).toBe(true);
  const content =
    readFileSync(path, "utf8")
      .replace("REGISTRATION_MODE=open", "REGISTRATION_MODE=closed")
      .replace(
        "RPC_URL=http://127.0.0.1:8545",
        "RPC_URL=https://trusted-rpc.example",
      ) +
    "OPERATOR_ADDRESSES=0x0000000000000000000000000000000000000001\nSTORAGE_KEY_VAULT_REF_FILE=/etc/contentproof/key.ref.json\n";
  writeFileSync(path, content);
  expect(initializeCloudConfig(path, "203.0.113.20").created).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(content);
  const legacy = content.replace("TRUSTED_PROXIES=127.0.0.1/32\n", "");
  writeFileSync(path, legacy);
  initializeCloudConfig(path, "203.0.113.20");
  expect(readFileSync(path, "utf8")).toBe(
    legacy + "TRUSTED_PROXIES=127.0.0.1/32\n",
  );
  writeFileSync(path, "REGISTRATION_MODE=closed\n");
  expect(() => initializeCloudConfig(path, "203.0.113.20")).toThrow(
    "REQUIRES_REVIEW",
  );
  expect(readFileSync(path, "utf8")).toBe("REGISTRATION_MODE=closed\n");
});
