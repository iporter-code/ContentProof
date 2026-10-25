import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { referenceWallet } from "../packages/chain/reference-wallet.js";
function root() {
  mkdirSync("data/test-reference-wallet", { recursive: true });
  return mkdtempSync(resolve("data/test-reference-wallet/run-"));
}
it("private fee key survives restarts and demo cannot open its directory", () => {
  const dir = root(),
    first = referenceWallet(dir, false);
  expect(referenceWallet(dir, false)).toEqual(first);
  expect(() => referenceWallet(dir, true)).toThrow("CHAIN_MODE_MISMATCH");
});
it("demo wallets stay explicit and cannot be reused as private wallets", () => {
  const dir = root(),
    demo = referenceWallet(dir, true);
  expect(demo).toMatchObject({ totalAccounts: 10, defaultBalance: 10000 });
  expect(existsSync(resolve(dir, "node.key"))).toBe(false);
  expect(() => referenceWallet(dir, false)).toThrow("CHAIN_MODE_MISMATCH");
});
it("missing historical fee keys stop startup instead of generating a new identity", () => {
  const dir = root();
  mkdirSync(resolve(dir, "chain-db"));
  expect(() => referenceWallet(dir, false)).toThrow(
    "RELAYER_KEY_RECOVERY_REQUIRED",
  );
  expect(existsSync(resolve(dir, "node.key"))).toBe(false);
  expect(() => referenceWallet(dir, true)).toThrow(
    "DEMO_PRIVATE_DIRECTORY_FORBIDDEN",
  );
});
