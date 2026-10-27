import { it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import {
  createVault,
  unlockVault,
  vaults,
  lockWallet,
  signText,
  signTyped,
  signingAddress,
  connectExternal,
  readVaultState,
  importVault,
  parseVaultBackup,
} from "../apps/web/src/wallet.js";
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
    get length() {
      return memory.size;
    },
    key: (i: number) => [...memory.keys()][i] ?? null,
  },
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: { removeItem: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: { dispatchEvent: () => {} },
  configurable: true,
});
beforeEach(() => {
  lockWallet();
  delete (window as any).ethereum;
  memory.clear();
});
it("restores an encrypted backup after local records are absent without changing the signer", async () => {
  const v = await createVault("backup-test", "synthetic-backup-password");
  lockWallet();
  memory.clear();
  expect(readVaultState()).toEqual({ vaults: [], issue: null });
  await expect(importVault(JSON.stringify(v), "wrong")).rejects.toThrow();
  expect(vaults()).toEqual([]);
  const restored = await importVault(
    JSON.stringify(v),
    "synthetic-backup-password",
  );
  await expect(unlockVault(restored, "wrong")).rejects.toThrow();
  await unlockVault(restored, "synthetic-backup-password");
  expect(signingAddress()).toBe(v.address);
});
it("keeps malformed local data instead of overwriting it while creating or importing", async () => {
  const backup = await createVault(
    "preserve-test",
    "synthetic-backup-password",
  );
  const damaged = "{broken";
  memory.set("contentproof-vaults", damaged);
  expect(readVaultState().issue).toBe("invalid");
  await expect(
    createVault("other", "synthetic-other-password"),
  ).rejects.toThrow("原数据");
  await expect(
    importVault(JSON.stringify(backup), "synthetic-backup-password"),
  ).rejects.toThrow("原数据");
  expect(memory.get("contentproof-vaults")).toBe(damaged);
});
it("distinguishes unavailable browser storage from an empty identity list", () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  )!;
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: () => {
        throw Error("denied");
      },
    },
    configurable: true,
  });
  try {
    expect(readVaultState()).toEqual({ vaults: [], issue: "unavailable" });
  } finally {
    Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});
it("rejects a verification report as an identity backup", () => {
  expect(() =>
    parseVaultBackup(
      JSON.stringify({
        schemaVersion: "contentproof-report/1",
        outcome: "fail",
      }),
    ),
  ).toThrow("这是核验结果报告");
  expect(vaults()).toEqual([]);
});
it("a corrupt same-address backup leaves the stored identity and active signer unchanged", async () => {
  const original = await createVault("original", "synthetic-original-password");
  const snapshot = [...memory.entries()];
  const damaged = { ...original };
  const cipher = Buffer.from(damaged.ciphertext, "base64");
  cipher[0] ^= 1;
  damaged.ciphertext = cipher.toString("base64");
  await expect(
    importVault(JSON.stringify(damaged), "synthetic-original-password"),
  ).rejects.toThrow("口令错误或备份已损坏");
  expect([...memory.entries()]).toEqual(snapshot);
  expect(signingAddress()).toBe(original.address);
  await unlockVault(vaults()[0], "synthetic-original-password");
});
it("a backup address must match its decrypted signing key before any write", async () => {
  const original = await createVault("original", "synthetic-original-password");
  const snapshot = [...memory.entries()];
  await expect(
    importVault(
      JSON.stringify({
        ...original,
        address: "0x1111111111111111111111111111111111111111",
      }),
      "synthetic-original-password",
    ),
  ).rejects.toThrow();
  expect([...memory.entries()]).toEqual(snapshot);
});
it("a failed storage write preserves existing records and the active identity", async () => {
  const original = await createVault("original", "synthetic-original-password");
  const snapshot = [...memory.entries()];
  const setter = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw Error("quota");
  });
  try {
    await expect(createVault("new", "synthetic-new-password")).rejects.toThrow(
      "未能保存身份",
    );
    await expect(
      importVault(JSON.stringify(original), "synthetic-original-password"),
    ).rejects.toThrow("未能保存身份");
    expect([...memory.entries()]).toEqual(snapshot);
    expect(signingAddress()).toBe(original.address);
  } finally {
    setter.mockRestore();
  }
});
it("concurrent additions from independent wallet module contexts preserve both identities and legacy records", async () => {
  const legacy = await createVault("legacy", "synthetic-legacy-password");
  memory.clear();
  memory.set("contentproof-vaults", JSON.stringify([legacy]));
  const legacyBytes = memory.get("contentproof-vaults");
  vi.resetModules();
  const other = await import("../apps/web/src/wallet.js");
  const created = await Promise.all([
    createVault("context-one", "synthetic-first-password"),
    other.createVault("context-two", "synthetic-second-password"),
  ]);
  expect(vaults()).toHaveLength(3);
  expect(other.vaults()).toHaveLength(3);
  for (const v of created)
    expect(vaults().some((row) => row.address === v.address)).toBe(true);
  expect(memory.get("contentproof-vaults")).toBe(legacyBytes);
  other.lockWallet();
});
it("switching to an external wallet drops the previous delegated signer", async () => {
  await createVault("master", "only-local-test-password");
  await createVault("delegate", "delegate-password-123", false);
  const address = "0x1111111111111111111111111111111111111111";
  const signature = `0x${"11".repeat(65)}`;
  const methods: string[] = [];
  (window as any).ethereum = {
    request: async ({ method }: { method: string }) => {
      methods.push(method);
      if (method === "eth_requestAccounts") return [address];
      if (method === "eth_accounts") return [address];
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_signTypedData_v4") return signature;
      throw Error(`Unexpected wallet request: ${method}`);
    },
  };
  expect(await connectExternal()).toBe(address);
  expect(
    await signTyped({
      domain: { name: "test", version: "1", chainId: 31337 },
      types: { Claim: [{ name: "nonce", type: "uint256" }] },
      primaryType: "Claim",
      message: { nonce: 1n },
    }),
  ).toBe(signature);
  expect(methods).toContain("eth_signTypedData_v4");
});
it("encrypted user vault rejects wrong passwords and resumes the same signer", async () => {
  const v = await createVault("wallet-test", "only-local-test-password");
  const signature = await signText("login challenge");
  expect(
    await recoverMessageAddress({ message: "login challenge", signature }),
  ).toBe(v.address);
  expect(JSON.stringify(v)).not.toContain("privateKey");
  lockWallet();
  await expect(signText("x")).rejects.toThrow();
  await expect(unlockVault(v, "wrong")).rejects.toThrow();
  await unlockVault(v, "only-local-test-password");
  expect(signingAddress()).toBe(v.address);
  expect(vaults()).toHaveLength(1);
});
it("independent signing-key rotation leaves login/admin identity unchanged", async () => {
  const master = await createVault("master", "only-local-test-password"),
    delegate = await createVault("delegate", "delegate-password-123", false);
  expect(signingAddress()).toBe(master.address);
  const input = {
    domain: { name: "test", version: "1", chainId: 31337 },
    types: { Claim: [{ name: "nonce", type: "uint256" }] },
    primaryType: "Claim",
    message: { nonce: 1n },
  } as const;
  const signature = await signTyped(input);
  expect(await recoverTypedDataAddress({ ...input, signature })).toBe(
    delegate.address,
  );
  const admin = await signText("admin action");
  expect(
    await recoverMessageAddress({ message: "admin action", signature: admin }),
  ).toBe(master.address);
});

const testAddress = "0x1111111111111111111111111111111111111111";
const testSignature = `0x${"11".repeat(65)}`;
const claimData = {
  domain: { name: "test", version: "1", chainId: 31337 },
  types: { Claim: [{ name: "nonce", type: "uint256" }] },
  primaryType: "Claim",
  message: { nonce: 1n },
};
function providerFixture() {
  const provider = Object.assign(new EventEmitter(), {
    accounts: [testAddress] as unknown,
    chainId: "0x7a69",
    methods: [] as string[],
    signature: async () => testSignature,
    request: async ({ method }: { method: string }): Promise<unknown> => {
      provider.methods.push(method);
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return provider.accounts;
      if (method === "eth_chainId") return provider.chainId;
      if (method === "personal_sign" || method === "eth_signTypedData_v4")
        return provider.signature();
      throw Error(`Unexpected wallet request: ${method}`);
    },
  });
  (window as any).ethereum = provider;
  return provider;
}
it.each(["accountsChanged", "chainChanged", "disconnect"])(
  "%s locks the signer and removes provider listeners",
  async (event) => {
    const provider = providerFixture();
    await connectExternal();
    expect(provider.listenerCount(event)).toBe(1);
    provider.emit(event);
    expect(signingAddress()).toBeNull();
    await expect(signText("old session")).rejects.toThrow("请先解锁");
    for (const name of ["accountsChanged", "chainChanged", "disconnect"])
      expect(provider.listenerCount(name)).toBe(0);
  },
);
it("checks the actual chain before asking the wallet to sign a claim", async () => {
  const provider = providerFixture();
  await connectExternal();
  provider.chainId = "0x1";
  await expect(signTyped(claimData)).rejects.toThrow("钱包网络与声明链不一致");
  expect(provider.methods).not.toContain("eth_signTypedData_v4");
  expect(signingAddress()).toBeNull();
});
it.each([
  { accounts: [] },
  { accounts: ["0x2222222222222222222222222222222222222222"] },
  { accounts: [42] },
])("rejects a silent provider account change: %j", async ({ accounts }) => {
  const provider = providerFixture();
  await connectExternal();
  provider.accounts = accounts;
  await expect(signText("challenge")).rejects.toThrow("钱包账户已变化");
  expect(provider.methods).not.toContain("personal_sign");
  expect(signingAddress()).toBeNull();
});
it("discards an in-flight signature if the connection changes", async () => {
  const provider = providerFixture();
  await connectExternal();
  provider.signature = async () => {
    provider.emit("accountsChanged", []);
    return testSignature;
  };
  await expect(signText("challenge")).rejects.toThrow(
    "签署期间钱包连接发生变化",
  );
  expect(signingAddress()).toBeNull();
});
it("listener cleanup failures cannot retain a signer", async () => {
  const provider = providerFixture();
  await connectExternal();
  provider.removeListener = () => {
    throw Error("provider disconnected");
  };
  expect(() => lockWallet()).not.toThrow();
  expect(signingAddress()).toBeNull();
  await expect(signText("challenge")).rejects.toThrow();
});
it("empty and rejected connections cannot fall back to the previous identity", async () => {
  await createVault("local", "only-local-test-password");
  const provider = providerFixture();
  provider.accounts = [];
  await expect(connectExternal()).rejects.toThrow("钱包未提供有效账户");
  expect(signingAddress()).toBeNull();
  provider.request = async () => {
    throw Error("user rejected");
  };
  await expect(connectExternal()).rejects.toThrow("user rejected");
  expect(signingAddress()).toBeNull();
});
