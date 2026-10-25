import { createHash, randomBytes } from "node:crypto";
import canonicalize from "canonicalize";
import {
  hashTypedData,
  recoverTypedDataAddress,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { checkPolicy, type VerificationPolicy } from "./policy.js";
import { claimTypes } from "./signing.js";
export { claimTypes } from "./signing.js";

export type Hash = `0x${string}`;
export const ZERO = `0x${"00".repeat(32)}` as Hash;
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,76})$/)
  .refine((s) => BigInt(s) < 2n ** 256n);
export const coreSchema = z
  .object({
    protocol: z.literal("contentproof/1"),
    assetDigest: hex32,
    mediaType: z.enum(["image/png", "image/jpeg"]),
    byteLength: uint.min(1).max(20 * 1024 * 1024),
    claimsRoot: hex32,
    claimLeafCount: uint.max(128),
    parentsRoot: hex32,
    parentCount: uint.max(8),
    operation: z.enum([
      "import",
      "crop",
      "resize",
      "rotate",
      "compose",
      "ai-declaration",
    ]),
    engineDigest: hex32,
    issuer: address,
    keyEpoch: decimal,
    nonce: decimal,
    deadline: decimal,
  })
  .strict()
  .superRefine((core, ctx) => {
    const count =
      core.operation === "compose"
        ? 2
        : ["import", "ai-declaration"].includes(core.operation)
          ? 0
          : 1;
    if (core.parentCount !== count)
      ctx.addIssue({
        code: "custom",
        message: "OPERATION_PARENT_COUNT",
        path: ["parentCount"],
      });
    if ((count === 0) !== (core.engineDigest === ZERO))
      ctx.addIssue({
        code: "custom",
        message: "OPERATION_ENGINE_BINDING",
        path: ["engineDigest"],
      });
    if (BigInt(core.keyEpoch) === 0n)
      ctx.addIssue({
        code: "custom",
        message: "KEY_EPOCH_POSITIVE",
        path: ["keyEpoch"],
      });
  });
export type Core = z.infer<typeof coreSchema>;
export interface Domain {
  name: "ContentProof";
  version: "1";
  chainId: number;
  verifyingContract: Address;
}
export interface Field {
  path: string;
  value: unknown;
  salt: Hash;
}
export interface Parent {
  claimId: Hash;
  assetDigest: Hash;
  role: string;
  salt: Hash;
}
export interface Proof {
  index: number;
  leafCount: number;
  siblings: Hash[];
}
export interface Disclosure {
  fieldCommitments: Hash[];
  fields: (Field & { proof: Proof })[];
  parents: { index: number; commitment: Hash; parent?: Parent; proof: Proof }[];
}
export interface Manifest {
  core: Core;
  domain: Domain;
  signature: Hex;
  disclosure: Disclosure;
}
export interface PrivateManifest extends Manifest {
  privateFields: Field[];
  privateParents: Parent[];
}
const proofSchema = z
  .object({
    index: uint.max(127),
    leafCount: uint.max(128),
    siblings: z.array(hex32).max(8),
  })
  .strict();
const parentSchema = z
  .object({
    claimId: hex32,
    assetDigest: hex32,
    role: z.string().min(1).max(80),
    salt: hex32,
  })
  .strict();
const fieldSchema = z
  .object({
    path: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/),
    value: z.unknown(),
    salt: hex32,
    proof: proofSchema,
  })
  .strict();
export const manifestSchema = z
  .object({
    core: coreSchema,
    domain: z
      .object({
        name: z.literal("ContentProof"),
        version: z.literal("1"),
        chainId: uint.min(1),
        verifyingContract: address,
      })
      .strict(),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    disclosure: z
      .object({
        fieldCommitments: z.array(hex32).max(128),
        fields: z.array(fieldSchema).max(128),
        parents: z
          .array(
            z
              .object({
                index: uint.max(7),
                commitment: hex32,
                parent: parentSchema.optional(),
                proof: proofSchema,
              })
              .strict(),
          )
          .max(8),
      })
      .strict(),
  })
  .strict();

/** Strict parser retains duplicate-key detection before JSON.parse can discard keys. */
export function strictJSON(text: string): unknown {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024)
    throw new Error("JSON_TOO_LARGE");
  let p = 0;
  const ws = () => {
    while (/\s/.test(text[p] ?? "") && p < text.length) p++;
  };
  function str(): string {
    const start = p++;
    while (p < text.length) {
      const c = text[p++];
      if (c === "\\") {
        p++;
        continue;
      }
      if (c === '"') {
        const result = JSON.parse(text.slice(start, p)) as string;
        for (let i = 0; i < result.length; i++) {
          const n = result.charCodeAt(i);
          if (n >= 0xd800 && n <= 0xdbff) {
            const next = result.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff))
              throw new Error("INVALID_UNICODE");
          } else if (n >= 0xdc00 && n <= 0xdfff)
            throw new Error("INVALID_UNICODE");
        }
        return result;
      }
    }
    throw new Error("INVALID_JSON_STRING");
  }
  function value(depth: number): void {
    if (depth > 64) throw new Error("JSON_TOO_DEEP");
    ws();
    const c = text[p];
    if (c === '"') {
      str();
      return;
    }
    if (c === "{") {
      p++;
      ws();
      const keys = new Set<string>();
      if (text[p] === "}") {
        p++;
        return;
      }
      while (p < text.length) {
        ws();
        if (text[p] !== '"') throw new Error("INVALID_JSON");
        const key = str();
        if (keys.has(key)) throw new Error("DUPLICATE_KEY");
        keys.add(key);
        ws();
        if (text[p++] !== ":") throw new Error("INVALID_JSON");
        value(depth + 1);
        ws();
        const end = text[p++];
        if (end === "}") return;
        if (end !== ",") throw new Error("INVALID_JSON");
      }
      throw new Error("INVALID_JSON");
    }
    if (c === "[") {
      p++;
      ws();
      if (text[p] === "]") {
        p++;
        return;
      }
      while (p < text.length) {
        value(depth + 1);
        ws();
        const end = text[p++];
        if (end === "]") return;
        if (end !== ",") throw new Error("INVALID_JSON");
      }
      throw new Error("INVALID_JSON");
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(p),
      );
    if (!match) throw new Error("INVALID_JSON");
    p += match[0].length;
    if (/^-?\d/.test(match[0])) {
      const n = Number(match[0]);
      if (
        !Number.isFinite(n) ||
        (Number.isInteger(n) && !Number.isSafeInteger(n))
      )
        throw new Error("UNSAFE_NUMBER");
    }
  }
  value(0);
  ws();
  if (p !== text.length) throw new Error("INVALID_JSON");
  return JSON.parse(text);
}
export function jcs(value: unknown): Buffer {
  const result = canonicalize(value);
  if (result === undefined) throw new Error("INVALID_CANONICAL_VALUE");
  strictJSON(result);
  return Buffer.from(result, "utf8");
}
export function hashBytes(bytes: Uint8Array): Hash {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}
export function salt(): Hash {
  return `0x${randomBytes(32).toString("hex")}`;
}
function raw(h: Hash): Buffer {
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error("INVALID_HASH");
  return Buffer.from(h.slice(2), "hex");
}
function leaf(domain: string, index: number, object: object): Hash {
  return hashBytes(
    Buffer.concat([Buffer.from([0]), jcs({ domain, index, ...object })]),
  );
}
export const commitField = (f: Field, index: number): Hash =>
  leaf("contentproof/field/1", index, {
    path: f.path,
    value: f.value,
    salt: f.salt,
  });
export const commitParent = (f: Parent, index: number): Hash =>
  leaf("contentproof/parent/1", index, f);
export const EMPTY_ROOT = hashBytes(Buffer.from("contentproof/empty/1"));
function pair(a: Hash, b: Hash): Hash {
  return hashBytes(Buffer.concat([Buffer.from([1]), raw(a), raw(b)]));
}
export function merkleRoot(leaves: Hash[]): Hash {
  if (!leaves.length) return EMPTY_ROOT;
  if (leaves.length > 128) throw new Error("TOO_MANY_LEAVES");
  let level = [...leaves];
  level.forEach(raw);
  while (level.length > 1) {
    const next: Hash[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(pair(level[i], level[i + 1] ?? level[i]));
    level = next;
  }
  return level[0];
}
export function merkleProof(leaves: Hash[], index: number): Proof {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length)
    throw new Error("INVALID_INDEX");
  const siblings: Hash[] = [];
  let level = [...leaves],
    pos = index;
  while (level.length > 1) {
    siblings.push(level[pos ^ 1] ?? level[pos]);
    const next: Hash[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(pair(level[i], level[i + 1] ?? level[i]));
    pos = Math.floor(pos / 2);
    level = next;
  }
  return { index, leafCount: leaves.length, siblings };
}
export function verifyProof(leaf: Hash, proof: Proof, root: Hash): boolean {
  try {
    proofSchema.parse(proof);
    if (proof.leafCount < 1 || proof.index >= proof.leafCount) return false;
    let current = leaf,
      pos = proof.index,
      width = proof.leafCount,
      level = 0;
    while (width > 1) {
      const sibling = proof.siblings[level++];
      if (!sibling) return false;
      if ((pos ^ 1) >= width && sibling !== current) return false;
      current = pos % 2 ? pair(sibling, current) : pair(current, sibling);
      pos = Math.floor(pos / 2);
      width = Math.ceil(width / 2);
    }
    return level === proof.siblings.length && current === root;
  } catch {
    return false;
  }
}
export function typedData(core: Core, domain: Domain) {
  coreSchema.parse(core);
  return {
    domain,
    types: claimTypes,
    primaryType: "Claim" as const,
    message: {
      ...core,
      assetDigest: core.assetDigest as Hash,
      claimsRoot: core.claimsRoot as Hash,
      parentsRoot: core.parentsRoot as Hash,
      engineDigest: core.engineDigest as Hash,
      issuer: getAddress(core.issuer),
      byteLength: BigInt(core.byteLength),
      keyEpoch: BigInt(core.keyEpoch),
      nonce: BigInt(core.nonce),
      deadline: BigInt(core.deadline),
    },
  };
}
export const claimId = (m: Pick<Manifest, "core" | "domain">): Hash =>
  hashTypedData(typedData(m.core, m.domain));
export async function signer(m: Manifest): Promise<Address> {
  return recoverTypedDataAddress({
    ...typedData(m.core, m.domain),
    signature: m.signature,
  });
}
export function prepare(
  core: Omit<
    Core,
    "claimsRoot" | "parentsRoot" | "claimLeafCount" | "parentCount"
  >,
  fields: Field[],
  parents: Parent[],
) {
  const ordered = [...fields].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  if (new Set(ordered.map((f) => f.path)).size !== ordered.length)
    throw new Error("DUPLICATE_PATH");
  const cf = ordered.map(commitField),
    cp = parents.map(commitParent);
  return {
    core: coreSchema.parse({
      ...core,
      claimsRoot: merkleRoot(cf),
      claimLeafCount: cf.length,
      parentsRoot: merkleRoot(cp),
      parentCount: cp.length,
    }),
    fields: ordered,
    parents,
  };
}
export function disclose(
  full: PrivateManifest,
  hideFields: string[] = [],
  hideParents: number[] = [],
): Manifest {
  const cf = full.privateFields.map(commitField),
    cp = full.privateParents.map(commitParent);
  return {
    core: full.core,
    domain: full.domain,
    signature: full.signature,
    disclosure: {
      fieldCommitments: cf,
      fields: full.privateFields.flatMap((f, i) =>
        hideFields.includes(f.path)
          ? []
          : [{ ...f, proof: merkleProof(cf, i) }],
      ),
      parents: full.privateParents.map((parent, index) => ({
        index,
        commitment: cp[index],
        ...(!hideParents.includes(index) ? { parent } : {}),
        proof: merkleProof(cp, index),
      })),
    },
  };
}
export function checkDisclosure(m: Manifest): "complete" | "partial" {
  const { core: c, disclosure: d } = m;
  manifestSchema.parse(m);
  if (
    d.fieldCommitments.length !== c.claimLeafCount ||
    merkleRoot(d.fieldCommitments) !== c.claimsRoot
  )
    throw new Error("FIELD_ROOT_MISMATCH");
  if (
    d.parents.length !== c.parentCount ||
    merkleRoot(d.parents.map((p) => p.commitment)) !== c.parentsRoot
  )
    throw new Error("PARENT_ROOT_MISMATCH");
  const indices = new Set<number>(),
    paths = new Map<number, string>();
  for (const f of d.fields) {
    const i = f.proof.index;
    if (indices.has(i) || [...paths.values()].includes(f.path))
      throw new Error("DUPLICATE_FIELD");
    indices.add(i);
    paths.set(i, f.path);
    if (
      f.proof.leafCount !== c.claimLeafCount ||
      commitField(f, i) !== d.fieldCommitments[i] ||
      !verifyProof(commitField(f, i), f.proof, c.claimsRoot)
    )
      throw new Error("FIELD_PROOF_INVALID");
  }
  const revealed = [...paths.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < revealed.length; i++)
    if (revealed[i - 1][1] >= revealed[i][1])
      throw new Error("FIELD_ORDER_INVALID");
  for (const [i, p] of d.parents.entries()) {
    if (
      p.index !== i ||
      p.proof.index !== i ||
      p.proof.leafCount !== c.parentCount ||
      !verifyProof(p.commitment, p.proof, c.parentsRoot)
    )
      throw new Error("PARENT_PROOF_INVALID");
    if (p.parent && commitParent(p.parent, i) !== p.commitment)
      throw new Error("PARENT_COMMITMENT_INVALID");
  }
  return d.fields.length === c.claimLeafCount &&
    d.parents.every((p) => p.parent)
    ? "complete"
    : "partial";
}
export type AnchorStatus =
  "confirmed" | "absent" | "offline" | "pending" | "mismatch" | "withdrawn";
export type IdentityStatus =
  "active" | "retired" | "revoked" | "unknown" | "unchecked";
export interface Observation {
  errorCode?: string;
  anchor: AnchorStatus;
  identity: IdentityStatus;
  blockNumber?: string;
  blockHash?: Hash;
  confirmations?: number;
}
export interface Report {
  schemaVersion: "contentproof-report/1";
  claimId: string;
  checkedAt: string;
  outcome: "pass" | "fail" | "incomplete";
  checks: {
    file: "match" | "mismatch" | "not-provided";
    signature: "valid" | "invalid" | "unchecked";
    anchor: AnchorStatus;
    identity: IdentityStatus;
    disclosure: "complete" | "partial" | "invalid";
    ancestry: "complete-declared-graph" | "withheld" | "missing" | "invalid";
    transformation: "reproduced" | "declared-only" | "unavailable" | "mismatch";
  };
  graph: {
    nodes: number;
    declaredSlots: number;
    disclosedSlots: number;
    verifiedSlots: number;
    missingSlots: number;
    withheldSlots: number;
  };
  reasons: { code: string; claimId?: string; message: string }[];
  chainObservation?: Observation;
}
export interface VerifyDependencies {
  signal?: AbortSignal;
  maxDurationMs?: number;
  policy?: VerificationPolicy;
  manifests: Map<string, Manifest>;
  files: Map<string, Uint8Array>;
  observe?: (m: Manifest, recovered: Address) => Promise<Observation>;
  reproduce?: (
    m: Manifest,
    parents: Manifest[],
    files: Map<string, Uint8Array>,
  ) => Promise<"reproduced" | "declared-only" | "unavailable" | "mismatch">;
}
export async function verify(
  rootId: string,
  deps: VerifyDependencies,
): Promise<Report> {
  const r: Report = {
    schemaVersion: "contentproof-report/1",
    claimId: rootId,
    checkedAt: new Date().toISOString(),
    outcome: "incomplete",
    checks: {
      file: "not-provided",
      signature: "unchecked",
      anchor: "offline",
      identity: "unchecked",
      disclosure: "complete",
      ancestry: "complete-declared-graph",
      transformation: "declared-only",
    },
    graph: {
      nodes: 0,
      declaredSlots: 0,
      disclosedSlots: 0,
      verifiedSlots: 0,
      missingSlots: 0,
      withheldSlots: 0,
    },
    reasons: [],
  };
  let fatal = false,
    incomplete = false;
  const started = Date.now();
  const seen = new Set<string>(),
    active = new Set<string>();
  const verdicts = new Map<string, boolean>();
  const reason = (code: string, id: string, message = code) =>
    r.reasons.push({ code, claimId: id, message });
  async function walk(id: string, depth: number): Promise<boolean> {
    if (
      deps.signal?.aborted ||
      Date.now() - started > (deps.maxDurationMs ?? 60000)
    )
      throw Error("VERIFICATION_INTERRUPTED");
    if (seen.size % 16 === 0) await new Promise<void>((r) => setImmediate(r));
    if (active.has(id)) throw new Error("GRAPH_CYCLE");
    if (seen.has(id)) return verdicts.get(id) ?? false;
    if (depth > 64 || seen.size >= 1000) throw new Error("GRAPH_LIMIT");
    const m = deps.manifests.get(id);
    if (!m) {
      r.graph.missingSlots++;
      incomplete = true;
      reason("MISSING_MANIFEST", id);
      return false;
    }
    active.add(id);
    seen.add(id);
    r.graph.nodes++;
    let stage = "schema",
      valid = true;
    try {
      manifestSchema.parse(m);
      if (claimId(m) !== id) throw new Error("CLAIM_ID_MISMATCH");
      if (deps.policy && !checkPolicy(m, deps.policy)) {
        fatal = true;
        valid = false;
        reason("POLICY_REJECTED", id);
      }
      stage = "disclosure";
      const disclosure = checkDisclosure(m);
      if (disclosure === "partial") {
        r.checks.disclosure = "partial";
        incomplete = true;
        valid = false;
      }
      stage = "signature";
      const recovered = await signer(m);
      if (id === rootId) r.checks.signature = "valid";
      stage = "chain";
      const observation = deps.observe
        ? await deps.observe(m, recovered)
        : { anchor: "offline" as const, identity: "unchecked" as const };
      if (id === rootId) {
        r.checks.anchor = observation.anchor;
        r.checks.identity = observation.identity;
        r.chainObservation = observation;
      }
      if (
        ["mismatch", "withdrawn"].includes(observation.anchor) ||
        ["revoked", "unknown"].includes(observation.identity)
      ) {
        fatal = true;
        valid = false;
        reason("CHAIN_OR_IDENTITY_REJECTED", id);
      } else if (observation.anchor !== "confirmed") {
        incomplete = true;
        valid = false;
        reason(observation.errorCode ?? "CHAIN_NOT_CONFIRMED", id);
      }
      stage = "file";
      const bytes = deps.files.get(m.core.assetDigest);
      if (bytes) {
        if (
          hashBytes(bytes) !== m.core.assetDigest ||
          bytes.length !== m.core.byteLength
        ) {
          fatal = true;
          valid = false;
          if (id === rootId) r.checks.file = "mismatch";
          reason("FILE_MISMATCH", id);
        } else if (id === rootId) r.checks.file = "match";
      } else {
        incomplete = true;
        valid = false;
        reason("MEDIA_NOT_PROVIDED", id);
      }
      stage = "parents";
      const parents: Manifest[] = [];
      for (const slot of m.disclosure.parents) {
        r.graph.declaredSlots++;
        if (!slot.parent) {
          r.graph.withheldSlots++;
          incomplete = true;
          valid = false;
          reason("PARENT_WITHHELD", id);
          continue;
        }
        r.graph.disclosedSlots++;
        const p = deps.manifests.get(slot.parent.claimId);
        if (p) {
          if (p.core.assetDigest !== slot.parent.assetDigest)
            throw new Error("PARENT_ASSET_MISMATCH");
          parents.push(p);
        }
        const parentVerified = await walk(slot.parent.claimId, depth + 1);
        if (p && parentVerified) r.graph.verifiedSlots++;
        else valid = false;
      }
      stage = "transformation";
      const transform = deps.reproduce
        ? await deps.reproduce(m, parents, deps.files)
        : ["import", "ai-declaration"].includes(m.core.operation)
          ? ("declared-only" as const)
          : ("unavailable" as const);
      if (id === rootId) r.checks.transformation = transform;
      if (transform === "mismatch") {
        fatal = true;
        valid = false;
        reason("TRANSFORM_MISMATCH", id);
      }
      if (transform === "unavailable") {
        incomplete = true;
        valid = false;
        reason("TRANSFORM_UNAVAILABLE", id);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "VERIFICATION_INTERRUPTED"
      )
        throw error;
      fatal = true;
      valid = false;
      if (stage === "schema" || stage === "disclosure")
        r.checks.disclosure = "invalid";
      if (stage === "schema" || stage === "parents")
        r.checks.ancestry = "invalid";
      if (stage === "signature" && id === rootId)
        r.checks.signature = "invalid";
      reason(
        "INVALID_EVIDENCE",
        id,
        error instanceof Error ? error.message : "INVALID_EVIDENCE",
      );
    }
    active.delete(id);
    verdicts.set(id, valid);
    return valid;
  }
  try {
    await walk(rootId, 0);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "VERIFICATION_INTERRUPTED"
    ) {
      incomplete = true;
      reason(
        "VERIFICATION_INTERRUPTED",
        rootId,
        "Verification stopped before all evidence was checked",
      );
    } else {
      fatal = true;
      r.checks.ancestry = "invalid";
      reason("GRAPH_REJECTED", rootId, String(error));
    }
  }
  if (r.checks.ancestry !== "invalid")
    r.checks.ancestry = r.graph.missingSlots
      ? "missing"
      : r.graph.withheldSlots
        ? "withheld"
        : "complete-declared-graph";
  r.outcome = fatal ? "fail" : incomplete ? "incomplete" : "pass";
  return r;
}
