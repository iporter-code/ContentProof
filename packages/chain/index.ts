import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  defineChain,
  type Address,
  type Abi,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  dataPath,
  rpcUrl,
  rpcUrls,
  chainId,
  demoMode,
  confirmations,
} from "../config/index.js";
import { hashBytes } from "../protocol/index.js";
import {
  claimId,
  type Manifest,
  type Observation,
  type Domain,
  type Hash,
} from "../protocol/index.js";
export const dataDir = dataPath;
export const rpc = rpcUrl;
export const localChain = defineChain({
  id: chainId,
  name: "ContentProof Local EVM",
  nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } },
});
const transport = () =>
  rpcUrls.length === 1
    ? http(rpc, { timeout: 5000, retryCount: 0 })
    : fallback(
        rpcUrls.map((url) => http(url, { timeout: 1500, retryCount: 0 })),
        { retryCount: 0, rank: false },
      );
export const publicClient = createPublicClient({
  chain: localChain,
  transport: transport(),
});
/** Public Hardhat development mnemonic; NEVER use these accounts on real networks. */
export const demoAccount = (index: number) =>
  mnemonicToAccount(
    "test test test test test test test test test test test junk",
    { addressIndex: index },
  );
export function relayerAccount() {
  const secret =
    process.env.RELAYER_PRIVATE_KEY ??
    readFileSync(resolve(dataDir, "node.key"), "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) throw Error("INVALID_RELAYER_KEY");
  return privateKeyToAccount(secret as `0x${string}`);
}
export const wallet = (index = 0) =>
  createWalletClient({
    account: demoMode ? demoAccount(index) : relayerAccount(),
    chain: localChain,
    transport: transport(),
  });
export interface Deployment {
  chainId: number;
  identity: Address;
  provenance: Address;
  identityAbi: Abi;
  provenanceAbi: Abi;
  blockNumber: string;
  codeHash: string;
  identityCodeHash?: string;
}
let queue = Promise.resolve();
export async function withRelayer<T>(fn: () => Promise<T>): Promise<T> {
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((r) => (release = r));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
export async function validateDeployment() {
  const d = deployment();
  if ((await publicClient.getChainId()) !== d.chainId)
    throw Error("CHAIN_ID_MISMATCH");
  const [p, i] = await Promise.all([
    publicClient.getCode({ address: d.provenance }),
    publicClient.getCode({ address: d.identity }),
  ]);
  if (!p || !i) throw Error("CONTRACT_NOT_DEPLOYED");
  if (
    hashBytes(Buffer.from(p.slice(2), "hex")) !== d.codeHash ||
    (d.identityCodeHash &&
      hashBytes(Buffer.from(i.slice(2), "hex")) !== d.identityCodeHash)
  )
    throw Error("CONTRACT_CODE_MISMATCH");
  return d;
}
export function deployment(): Deployment {
  const p = resolve(dataDir, "deployment.json");
  if (!existsSync(p)) throw new Error("请先运行 npm run deploy");
  return JSON.parse(readFileSync(p, "utf8"));
}
export const domain = (): Domain => ({
  name: "ContentProof",
  version: "1",
  chainId: deployment().chainId,
  verifyingContract: deployment().provenance,
});
export function chainCore(m: Manifest) {
  const c = m.core;
  return {
    ...c,
    byteLength: BigInt(c.byteLength),
    keyEpoch: BigInt(c.keyEpoch),
    nonce: BigInt(c.nonce),
    deadline: BigInt(c.deadline),
  };
}
export async function nonce(issuer: Address, epoch = 1n): Promise<string> {
  const d = deployment();
  return String(
    await publicClient.readContract({
      address: d.provenance,
      abi: d.provenanceAbi,
      functionName: "nonces",
      args: [issuer, epoch],
    }),
  );
}
export async function anchor(
  m: Manifest,
  index = 0,
  onSubmitted?: (hash: string) => void,
): Promise<{ txHash?: string; blockNumber: string }> {
  const d = deployment();
  if (
    m.domain.chainId !== d.chainId ||
    m.domain.verifyingContract.toLowerCase() !== d.provenance.toLowerCase()
  )
    throw new Error("WRONG_SIGNING_DOMAIN");
  const id = claimId(m);
  const r = (await publicClient.readContract({
    address: d.provenance,
    abi: d.provenanceAbi,
    functionName: "records",
    args: [id],
  })) as [Address, Hash, bigint, boolean];
  if (r[3]) throw Error("CLAIM_WITHDRAWN");
  if (r[2] > 0n) return { blockNumber: String(r[2]) };
  const txHash = await wallet(index).writeContract({
    address: d.provenance,
    abi: d.provenanceAbi,
    functionName: "registerClaim",
    args: [chainCore(m), m.signature],
  });
  onSubmitted?.(txHash);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 20000,
    confirmations,
  });
  if (receipt.status !== "success") throw new Error("ANCHOR_REVERTED");
  return { txHash, blockNumber: String(receipt.blockNumber) };
}
export async function observe(
  m: Manifest,
  recovered: Address,
): Promise<Observation> {
  try {
    const d = await validateDeployment();
    if (
      (await publicClient.getChainId()) !== d.chainId ||
      m.domain.chainId !== d.chainId ||
      m.domain.verifyingContract.toLowerCase() !== d.provenance.toLowerCase()
    )
      return { anchor: "mismatch", identity: "unknown" };
    const height = await publicClient.getBlockNumber({ cacheTime: 0 });
    const [record, key] = await Promise.all([
      publicClient.readContract({
        address: d.provenance,
        abi: d.provenanceAbi,
        functionName: "records",
        args: [claimId(m)],
        blockNumber: height,
      }) as Promise<[Address, Hash, bigint, boolean]>,
      publicClient.readContract({
        address: d.identity,
        abi: d.identityAbi,
        functionName: "keys",
        args: [m.core.issuer, BigInt(m.core.keyEpoch)],
        blockNumber: height,
      }) as Promise<[Address, bigint, bigint, bigint]>,
    ]);
    const identity =
      key[1] === 0n || key[0].toLowerCase() !== recovered.toLowerCase()
        ? "unknown"
        : key[3] > 0n
          ? "revoked"
          : key[2] > 0n
            ? "retired"
            : "active";
    if (record[2] === 0n) return { anchor: "absent", identity };
    if (
      record[0].toLowerCase() !== m.core.issuer.toLowerCase() ||
      record[1] !== m.core.assetDigest
    )
      return { anchor: "mismatch", identity };
    const block = await publicClient.getBlock({ blockNumber: record[2] });
    return {
      anchor: record[3]
        ? "withdrawn"
        : Number(height - record[2] + 1n) < confirmations
          ? "pending"
          : "confirmed",
      identity,
      blockNumber: String(record[2]),
      blockHash: block.hash as Hash,
      confirmations: Number(height - record[2] + 1n),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      /CHAIN_ID_MISMATCH|CONTRACT_CODE_MISMATCH|CONTRACT_NOT_DEPLOYED/.test(
        message,
      )
    )
      return { anchor: "mismatch", identity: "unchecked" };
    return {
      anchor: "offline",
      identity: "unchecked",
      errorCode: message.includes("npm run deploy")
        ? "DEPLOYMENT_MISSING"
        : "CHAIN_READ_FAILED",
    };
  }
}
