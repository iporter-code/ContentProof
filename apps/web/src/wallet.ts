import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { createWalletClient, custom, isAddress, type Hex } from "viem";
export interface Vault {
  version: 1;
  address: string;
  name: string;
  salt: string;
  iv: string;
  ciphertext: string;
}
// Individual keys make additions atomic across tabs without rewriting the legacy list.
const vaultPrefix = "contentproof-vault:";
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const base64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
let unlocked: PrivateKeyAccount | null = null;
let claimSigner: PrivateKeyAccount | null = null;
let external: ReturnType<typeof createWalletClient> | null = null;
let externalAddress: Hex | null = null;
let externalProvider: any = null;
let externalCleanup: (() => void) | null = null;
let externalGeneration = 0;
function detachExternal() {
  const cleanup = externalCleanup;
  externalCleanup = null;
  externalProvider = null;
  externalGeneration++;
  // Provider cleanup must never prevent clearing signing material and sessions.
  try {
    cleanup?.();
  } catch {
    /* A disconnected provider can reject listener removal. */
  }
}
function parsedVault(input: unknown): Vault {
  if (!input || typeof input !== "object") throw Error("INVALID_VAULT");
  const v = input as Vault;
  if (
    v.version !== 1 ||
    typeof v.address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(v.address) ||
    typeof v.name !== "string" ||
    ![v.salt, v.iv, v.ciphertext].every(
      (s) => typeof s === "string" && s.length < 1024,
    ) ||
    bytes(v.salt).length !== 16 ||
    bytes(v.iv).length !== 12 ||
    bytes(v.ciphertext).length < 17
  )
    throw Error("INVALID_VAULT");
  return {
    version: 1,
    address: v.address,
    name: v.name,
    salt: v.salt,
    iv: v.iv,
    ciphertext: v.ciphertext,
  };
}
export function readVaultState(): {
  vaults: Vault[];
  issue: "unavailable" | "invalid" | null;
} {
  let raw: string | null;
  const records: Array<[string, string]> = [];
  try {
    raw = localStorage.getItem("contentproof-vaults");
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name?.startsWith(vaultPrefix)) continue;
      const record = localStorage.getItem(name);
      if (record !== null) records.push([name, record]);
    }
  } catch {
    return { vaults: [], issue: "unavailable" };
  }
  try {
    const value = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) throw Error("INVALID_VAULT_LIST");
    const merged = new Map<string, Vault>(
      value.map((input: unknown) => {
        const vault = parsedVault(input);
        return [vault.address.toLowerCase(), vault];
      }),
    );
    for (const [name, record] of records) {
      const vault = parsedVault(JSON.parse(record));
      if (name !== vaultPrefix + vault.address.toLowerCase())
        throw Error("INVALID_VAULT_STORAGE_KEY");
      merged.set(vault.address.toLowerCase(), vault);
    }
    return { vaults: [...merged.values()], issue: null };
  } catch {
    return { vaults: [], issue: "invalid" };
  }
}
export const vaults = (): Vault[] => readVaultState().vaults;
function storedVaults() {
  const state = readVaultState();
  if (state.issue)
    throw Error(
      state.issue === "invalid"
        ? "本机身份记录异常，已保留原数据；请在可正常保存数据的浏览器中恢复加密备份"
        : "浏览器不允许读取本机身份，请检查网站存储权限或退出无痕模式后重试",
    );
  return state.vaults;
}
function saveVault(vault: Vault) {
  storedVaults();
  try {
    const name = vaultPrefix + vault.address.toLowerCase();
    const text = JSON.stringify(vault);
    localStorage.setItem(name, text);
    if (localStorage.getItem(name) !== text) throw Error();
  } catch {
    throw Error("浏览器未能保存身份，请检查网站存储权限或可用空间后重试");
  }
}
async function key(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 310000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function createVault(
  name: string,
  password: string,
  activate = true,
) {
  if (password.length < 12) throw Error("解锁口令至少12位");
  storedVaults();
  const secret = generatePrivateKey(),
    account = privateKeyToAccount(secret),
    salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(password, salt),
    new TextEncoder().encode(secret),
  );
  const v: Vault = {
    version: 1,
    name,
    address: account.address,
    salt: base64(salt),
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
  saveVault(v);
  if (activate) {
    detachExternal();
    unlocked = account;
    claimSigner = null;
    external = null;
    externalAddress = null;
  } else claimSigner = account;
  return v;
}
async function decryptVault(v: Vault, password: string) {
  try {
    const secret = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(v.iv) as BufferSource },
      await key(password, bytes(v.salt)),
      bytes(v.ciphertext) as BufferSource,
    );
    const account = privateKeyToAccount(
      new TextDecoder().decode(secret) as Hex,
    );
    if (account.address.toLowerCase() !== v.address.toLowerCase())
      throw Error();
    return account;
  } catch {
    throw Error("口令错误或备份已损坏");
  }
}
export async function unlockVault(v: Vault, password: string, activate = true) {
  const account = await decryptVault(v, password);
  if (activate) {
    detachExternal();
    unlocked = account;
    claimSigner = null;
    external = null;
    externalAddress = null;
  } else claimSigner = account;
}
export function parseVaultBackup(text: string) {
  let v: Vault;
  try {
    const input = JSON.parse(text);
    if (input?.schemaVersion === "contentproof-report/1")
      throw Error(
        "这是核验结果报告，请选择 contentproof-identity.encrypted.json 加密身份备份",
      );
    v = parsedVault(input);
  } catch (e) {
    if ((e as Error).message.startsWith("这是核验结果报告")) throw e;
    throw Error("无效的加密身份备份，请选择创建身份时保存的加密备份文件");
  }
  return v;
}
export async function importVault(text: string, password: string) {
  const v = parseVaultBackup(text);
  storedVaults();
  await decryptVault(v, password);
  saveVault(v);
  return v;
}
export const signingAddress = () => unlocked?.address ?? externalAddress;
export function lockWallet() {
  detachExternal();
  unlocked = null;
  claimSigner = null;
  external = null;
  externalAddress = null;
  sessionStorage.removeItem("cp-token");
  window.dispatchEvent(new Event("cp-locked"));
}
export async function connectExternal() {
  const provider = (window as unknown as { ethereum?: any }).ethereum;
  if (!provider) throw Error("未检测到钱包扩展；可以创建本地加密身份");
  lockWallet();
  const generation = externalGeneration;
  const client = createWalletClient({ transport: custom(provider) });
  const address = (await client.requestAddresses())[0];
  if (!address || !isAddress(address)) throw Error("钱包未提供有效账户");
  if (generation !== externalGeneration)
    throw Error("钱包连接已改变，请重新连接");
  external = client;
  externalAddress = address;
  externalProvider = provider;
  const reset = () => lockWallet();
  if (provider.on && provider.removeListener) {
    for (const event of ["accountsChanged", "chainChanged", "disconnect"])
      provider.on(event, reset);
    externalCleanup = () => {
      for (const event of ["accountsChanged", "chainChanged", "disconnect"]) {
        try {
          provider.removeListener(event, reset);
        } catch {
          /* Continue removing the remaining listeners. */
        }
      }
    };
  }
  unlocked = null;
  claimSigner = null;
  return externalAddress!;
}
async function externalContext(chainId?: number) {
  const generation = externalGeneration,
    client = external,
    address = externalAddress,
    provider = externalProvider;
  if (!client || !address || !provider) throw Error("请重新连接钱包");
  const accounts = await provider.request({ method: "eth_accounts" });
  if (
    generation !== externalGeneration ||
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    accounts[0].toLowerCase() !== address.toLowerCase()
  ) {
    lockWallet();
    throw Error("钱包账户已变化，请重新连接");
  }
  if (chainId !== undefined) {
    const current = await provider.request({ method: "eth_chainId" });
    if (Number(current) !== Number(chainId)) {
      lockWallet();
      throw Error("钱包网络与声明链不一致，请切换网络后重新连接");
    }
  }
  if (generation !== externalGeneration)
    throw Error("钱包连接已改变，请重新连接");
  return { client, address, generation };
}
function stableSignature(signature: Hex, generation: number) {
  if (generation !== externalGeneration)
    throw Error("签署期间钱包连接发生变化，已停止提交");
  return signature;
}
export async function signText(message: string) {
  if (unlocked) return unlocked.signMessage({ message });
  if (external && externalAddress) {
    const c = await externalContext();
    return stableSignature(
      await c.client.signMessage({ account: c.address, message }),
      c.generation,
    );
  }
  throw Error("请先解锁签名身份");
}
export async function signTyped(input: any) {
  const message = { ...input.message };
  for (const f of input.types[input.primaryType] ?? [])
    if (/^uint/.test(f.type) && f.type !== "uint32")
      message[f.name] = BigInt(message[f.name]);
  const data = { ...input, message };
  if (input.primaryType === "Claim" && claimSigner)
    return claimSigner.signTypedData(data);
  if (unlocked) return unlocked.signTypedData(data);
  if (external && externalAddress) {
    const c = await externalContext(data.domain?.chainId);
    return stableSignature(
      await c.client.signTypedData({ ...data, account: c.address }),
      c.generation,
    );
  }
  throw Error("请先解锁签名身份");
}
