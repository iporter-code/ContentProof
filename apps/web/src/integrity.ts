import { claimTypes } from "../../../packages/protocol/signing.js";
import canonicalize from "canonicalize";
import {
  sha256,
  stringToHex,
  concatHex,
  hashTypedData,
  type Hex,
  type TypedData,
} from "viem";

export interface SigningIntent {
  issuer: string;
  keyEpoch: string;
  domain: {
    name: "ContentProof";
    version: "1";
    chainId: number;
    verifyingContract: Hex;
  };
  operation: string;
  assetDigest: string;
  mediaType: string;
  byteLength: number;
  engineDigest: string;
  fields: Record<string, unknown>;
  parents: { claimId: string; assetDigest: string; role: string }[];
}
const canonical = (value: unknown) => {
  const text = canonicalize(value);
  if (typeof text !== "string") throw Error("声明内容无法规范化");
  return text;
};
const browserRoot = (leaves: Hex[]): Hex => {
  if (!leaves.length) return sha256(stringToHex("contentproof/empty/1"));
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(
        sha256(concatHex(["0x01", level[i], level[i + 1] ?? level[i]])),
      );
    level = next;
  }
  return level[0];
};
export function reviewPrepared(prepared: any, intent: SigningIntent) {
  const typed = reviewedTypedData(prepared),
    { core, fields, parents } = prepared;
  const reject = () => {
    throw Error("待签署内容与本地草稿不一致，已停止签署");
  };
  for (const name of [
    "operation",
    "assetDigest",
    "mediaType",
    "engineDigest",
    "byteLength",
    "keyEpoch",
  ] as const)
    if (core[name] !== intent[name]) reject();
  if (
    core.issuer.toLowerCase() !== intent.issuer.toLowerCase() ||
    canonical(typed.domain) !== canonical(intent.domain)
  )
    reject();
  const expectedFields = Object.entries(intent.fields).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (
    !Array.isArray(fields) ||
    !Array.isArray(parents) ||
    fields.length !== expectedFields.length ||
    fields.length !== core.claimLeafCount ||
    parents.length !== intent.parents.length ||
    parents.length !== core.parentCount
  )
    reject();
  const leaf = (
    domain: string,
    index: number,
    value: Record<string, unknown>,
  ) =>
    sha256(
      concatHex(["0x00", stringToHex(canonical({ domain, index, ...value }))]),
    );
  const fieldLeaves = fields.map((field: any, index: number) => {
    if (
      field.path !== expectedFields[index][0] ||
      canonical(field.value) !== canonical(expectedFields[index][1]) ||
      !/^0x[0-9a-f]{64}$/.test(field.salt)
    )
      reject();
    return leaf("contentproof/field/1", index, {
      path: field.path,
      value: field.value,
      salt: field.salt,
    });
  });
  const parentLeaves = parents.map((parent: any, index: number) => {
    const expected = intent.parents[index];
    if (
      parent.claimId !== expected.claimId ||
      parent.assetDigest !== expected.assetDigest ||
      parent.role !== expected.role ||
      !/^0x[0-9a-f]{64}$/.test(parent.salt)
    )
      reject();
    return leaf("contentproof/parent/1", index, {
      claimId: parent.claimId,
      assetDigest: parent.assetDigest,
      role: parent.role,
      salt: parent.salt,
    });
  });
  if (
    browserRoot(fieldLeaves) !== core.claimsRoot ||
    browserRoot(parentLeaves) !== core.parentsRoot
  )
    reject();
  if (BigInt(core.deadline) < BigInt(Math.floor(Date.now() / 1000)))
    throw Error("签署内容已过期，请重新准备");
  return typed;
}
export function reviewedClaimId(typed: ReturnType<typeof reviewedTypedData>) {
  return hashTypedData({
    ...typed,
    types: typed.types as TypedData,
    primaryType: "Claim",
  });
}

export const MAX_LOCAL_BYTES = 20 * 1024 * 1024;
export async function fileDigest(file: Blob): Promise<string> {
  if (file.size < 1 || file.size > MAX_LOCAL_BYTES)
    throw Error("文件大小须为1字节至20MB");
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return (
    "0x" +
    [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
export async function verifyFile(file: Blob, digest: string, size: number) {
  if (file.size !== size || (await fileDigest(file)) !== digest)
    throw Error("本地文件摘要校验失败，已停止签署或上传确认");
}
export async function boundedAsset(response: Response, size: number) {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_LOCAL_BYTES ||
    !response.body
  )
    throw Error("签署文件大小不正确");
  const reader = response.body.getReader(),
    chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > size) {
        await reader.cancel();
        throw Error("签署文件超过声明大小");
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}
export function reviewedTypedData(prepared: any) {
  const { core, domain } = prepared;
  if (
    !core ||
    Object.keys(core).length !== claimTypes.Claim.length ||
    core.protocol !== "contentproof/1" ||
    !["image/png", "image/jpeg"].includes(core.mediaType)
  )
    throw Error("声明格式不正确");
  if (
    !domain ||
    domain.name !== "ContentProof" ||
    domain.version !== "1" ||
    !Number.isSafeInteger(domain.chainId) ||
    domain.chainId < 1 ||
    !/^0x[0-9a-fA-F]{40}$/.test(domain.verifyingContract)
  )
    throw Error("签署域不正确");
  const message: Record<string, any> = {};
  for (const field of claimTypes.Claim) {
    const value = core[field.name];
    if (
      (field.type === "bytes32" && !/^0x[0-9a-f]{64}$/.test(value)) ||
      (field.type === "address" && !/^0x[0-9a-fA-F]{40}$/.test(value)) ||
      (field.type === "string" && typeof value !== "string")
    )
      throw Error("声明字段不正确");
    if (field.type.startsWith("uint")) {
      if (
        !/^(0|[1-9][0-9]{0,76})$/.test(String(value)) ||
        BigInt(value) >= 2n ** BigInt(field.type === "uint32" ? 32 : 256)
      )
        throw Error("声明数值不正确");
      message[field.name] =
        field.type === "uint32" ? Number(value) : BigInt(value);
    } else message[field.name] = value;
  }
  const count =
    core.operation === "compose"
      ? 2
      : ["import", "ai-declaration"].includes(core.operation)
        ? 0
        : ["crop", "resize", "rotate"].includes(core.operation)
          ? 1
          : -1;
  if (
    count !== core.parentCount ||
    (count === 0) !== (core.engineDigest === "0x" + "00".repeat(32)) ||
    core.byteLength < 1 ||
    core.byteLength > MAX_LOCAL_BYTES ||
    core.claimLeafCount > 128 ||
    BigInt(core.keyEpoch) < 1n
  )
    throw Error("声明操作与文件不一致");
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: claimTypes,
    primaryType: "Claim",
    message,
  };
}
export function grantExpiry(value: string): number | null {
  if (!value) return null;
  const expires = new Date(value).getTime();
  if (!Number.isSafeInteger(expires) || expires <= Date.now())
    throw Error("请选择未来的授权到期时间");
  return expires;
}
