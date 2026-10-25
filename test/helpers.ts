import {
  prepare,
  salt,
  disclose,
  typedData,
  ZERO,
  hashBytes,
  type PrivateManifest,
  type Field,
  type Parent,
  type Domain,
} from "../packages/protocol/index.js";
import { demoAccount } from "../packages/chain/index.js";
export const testDomain: Domain = {
  name: "ContentProof",
  version: "1",
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000001234",
};
export async function makeFull(
  options: {
    fields?: Field[];
    parents?: Parent[];
    bytes?: Uint8Array;
    operation?: "import" | "crop";
    engineDigest?: `0x${string}`;
  } = {},
): Promise<PrivateManifest> {
  const bytes = options.bytes ?? Buffer.from("test-image-bytes");
  const prepared = prepare(
    {
      protocol: "contentproof/1",
      assetDigest: hashBytes(bytes),
      mediaType: "image/png",
      byteLength: bytes.length,
      operation:
        options.operation ??
        ((options.parents?.length ?? 0) > 1
          ? "compose"
          : options.parents?.length
            ? "crop"
            : "import"),
      engineDigest:
        options.engineDigest ??
        (options.parents?.length
          ? hashBytes(Buffer.from("fixture-engine"))
          : ZERO),
      issuer: demoAccount(1).address,
      keyEpoch: "1",
      nonce: "0",
      deadline: "2000000000",
    },
    options.fields ?? [
      { path: "title", value: "example", salt: salt() },
      { path: "private.note", value: "secret", salt: salt() },
    ],
    options.parents ?? [],
  );
  const full = {
    core: prepared.core,
    domain: testDomain,
    signature: await demoAccount(1).signTypedData(
      typedData(prepared.core, testDomain),
    ),
    privateFields: prepared.fields,
    privateParents: prepared.parents,
  } as PrivateManifest;
  full.disclosure = disclose(full).disclosure;
  return full;
}
