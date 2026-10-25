import { it, expect, beforeEach } from "vitest";
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
} from "../apps/web/src/wallet.js";
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
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
