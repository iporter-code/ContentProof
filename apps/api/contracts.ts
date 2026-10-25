import { z } from "zod";
import { c2paReportSchema } from "../../packages/c2pa/report.js";
import type { FastifyInstance } from "fastify";
import {
  coreSchema,
  manifestSchema,
  hashBytes,
} from "../../packages/protocol/index.js";
import { claimTypes } from "../../packages/protocol/signing.js";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/),
  address = z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  id = z.string().uuid(),
  decimal = z.string().regex(/^(0|[1-9][0-9]*)$/),
  count = z.number().int().nonnegative(),
  time = z.number().int().nonnegative(),
  text = z.string();
const object = z.strictObject,
  json = z.json();
const operation = z.enum([
  "import",
  "ai-declaration",
  "crop",
  "resize",
  "rotate",
  "compose",
]);
const params = object({
  left: z.number().optional(),
  top: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  angle: z.number().optional(),
});
const asset = object({
  digest: hash,
  mediaType: z.enum(["image/png", "image/jpeg"]),
  size: count.positive(),
  width: count.positive(),
  height: count.positive(),
  canEdit: z.boolean().optional(),
});
const anchor = z.enum([
    "confirmed",
    "absent",
    "offline",
    "pending",
    "mismatch",
    "withdrawn",
  ]),
  identity = z.enum(["active", "retired", "revoked", "unknown", "unchecked"]);
const observation = object({
  anchor,
  identity,
  blockNumber: decimal.optional(),
  blockHash: hash.optional(),
  confirmations: count.optional(),
  errorCode: text.optional(),
});
const manifest = manifestSchema.extend({
  disclosure: manifestSchema.shape.disclosure.extend({
    fields: z
      .array(
        manifestSchema.shape.disclosure.shape.fields.element.extend({
          value: json,
        }),
      )
      .max(128),
  }),
});
const domain = manifest.shape.domain;
const typedFields = object(
  Object.fromEntries(
    claimTypes.Claim.map((f) => [
      f.name,
      f.type.startsWith("uint")
        ? f.type === "uint32"
          ? count
          : decimal
        : coreSchema.shape[f.name],
    ]),
  ),
);
const typed = object({
  domain,
  types: object({
    Claim: z.tuple(
      claimTypes.Claim.map((f) =>
        object({ name: z.literal(f.name), type: z.literal(f.type) }),
      ) as unknown as [z.ZodType, ...z.ZodType[]],
    ),
  }),
  primaryType: z.literal("Claim"),
  message: typedFields,
});
const claim = object({ id: hash, owner: address, core: coreSchema });
const draft = object({
  id,
  engineDigest: hash,
  assetDigest: hash,
  operation,
  parents: z.array(hash).max(2),
  fields: z.record(text, json),
  params: params.optional(),
});
const role = z.enum(["owner", "admin", "editor", "viewer"]),
  orgStatus = z.enum(["pending", "approved", "rejected", "suspended"]),
  membership = z.enum(["invited", "active"]);
const organization = object({
  id,
  name: text,
  status: orgStatus,
  applicant: address,
  evidenceDigest: hash,
  created: text,
});
const profile = object({ address, name: text, epoch: decimal, created: text });
const session = object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  address,
  demoMode: z.boolean(),
});
const grant = object({ granted: z.literal(true), expiresAt: time.nullable() });
const exportState = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
const report = object({
  schemaVersion: z.literal("contentproof-report/1"),
  claimId: hash,
  checkedAt: text,
  outcome: z.enum(["pass", "fail", "incomplete"]),
  checks: object({
    file: z.enum(["match", "mismatch", "not-provided"]),
    signature: z.enum(["valid", "invalid", "unchecked"]),
    anchor,
    identity,
    disclosure: z.enum(["complete", "partial", "invalid"]),
    ancestry: z.enum([
      "complete-declared-graph",
      "withheld",
      "missing",
      "invalid",
    ]),
    transformation: z.enum([
      "reproduced",
      "declared-only",
      "unavailable",
      "mismatch",
    ]),
  }),
  graph: object({
    nodes: count,
    declaredSlots: count,
    disclosedSlots: count,
    verifiedSlots: count,
    missingSlots: count,
    withheldSlots: count,
  }),
  reasons: z.array(
    object({ code: text, claimId: hash.optional(), message: text }),
  ),
  chainObservation: observation.optional(),
});
const healthy = object({
  workerError: text.nullable(),
  indexerError: text.nullable(),
});
const tx = object({ txHash: hash });
const updated = object({ updated: z.literal(true) });

// Every JSON domain response has one shared runtime/OpenAPI source of truth.
export const responseContracts: Record<string, z.ZodType> = {
  "GET /v1/system/alerts": object({
    operator: z.boolean(),
    alerts: z.array(
      object({
        sequence: count.positive(),
        id,
        code: z.string().regex(/^[A-Z_]+$/),
        severity: z.enum(["warning", "error"]),
        description: text,
        value: z.number(),
        threshold: z.number(),
        firstSeen: time,
        lastSeen: time,
        occurrences: count.positive(),
        acknowledgedAt: time.nullable(),
        resolvedAt: time.nullable(),
      }),
    ),
    open: count,
  }),
  "POST /v1/system/alerts/:id/ack": object({ acknowledged: z.literal(true) }),
  "GET /health/live": object({ alive: z.literal(true) }),
  "GET /health/ready": object({
    database: z.boolean(),
    chain: z.boolean(),
    demoMode: z.boolean(),
  }),
  "GET /v1/identities": object({
    demoMode: z.boolean(),
    identities: z.array(
      z.union([
        object({ index: count, address, label: text }),
        object({ address, label: text, epoch: decimal }),
      ]),
    ),
  }),
  "POST /v1/demo/login": session,
  "POST /v1/auth/challenge": object({
    id: z.string().length(48),
    message: text,
    expires: time,
  }),
  "POST /v1/auth/verify": session,
  "POST /v1/auth/logout": object({ loggedOut: z.literal(true) }),
  "GET /v1/profile": object({
    address,
    profile: profile.nullable(),
    demoMode: z.boolean(),
  }),
  "POST /v1/profile": object({ registered: z.literal(true) }),
  "GET /v1/keys": z.array(
    object({
      epoch: decimal,
      record: z.tuple([address, decimal, decimal, decimal]),
    }),
  ),
  "POST /v1/keys/challenge": object({
    id: z.string().length(48),
    message: text,
  }),
  "POST /v1/keys/action": tx,
  "POST /v1/assets/:digest/revoke": object({ revoked: z.literal(true) }),
  "POST /v1/claims/:id/revoke": object({
    revoked: z.literal(true),
    notice: text,
  }),
  "GET /v1/audit": z.array(
    object({ action: text, objectId: text, created: text }),
  ),
  "GET /v1/system/health": healthy,
  "GET /v1/system/metrics": object({
    requests: count,
    errors: count,
    totalMilliseconds: z.number().nonnegative(),
    inFlight: count,
    resources: object({ media: count, verify: count }),
    media: object({
      active: count,
      queued: count,
      concurrency: count.positive(),
    }),
    memory: object({
      rss: count,
      heapTotal: count,
      heapUsed: count,
      external: count,
      arrayBuffers: count,
    }),
    uptimeSeconds: z.number().nonnegative(),
    alerts: z.array(text),
  }),
  "POST /v1/assets": asset,
  "GET /v1/assets": z.array(asset),
  "GET /v1/assets/:digest": asset,
  "POST /v1/assets/:digest/grant": grant,
  "POST /v1/drafts/import": draft,
  "POST /v1/drafts/transform": draft,
  "PATCH /v1/drafts/:id": object({ id, revision: count.positive() }),
  "POST /v1/drafts/:id/prepare": object({
    core: coreSchema,
    domain,
    typedData: typed,
    fields: z.array(object({ path: text, value: json, salt: hash })).max(128),
    parents: z
      .array(
        object({ claimId: hash, assetDigest: hash, role: text, salt: hash }),
      )
      .max(8),
  }),
  "POST /v1/drafts/:id/signatures": object({ id: hash, manifest }),
  "POST /v1/demo/sign/:id": object({
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  }),
  "GET /v1/claims": z.array(claim),
  "GET /v1/claims/:id": object({
    manifest,
    chain: observation,
    fields: z.array(text),
    grants: z.array(
      object({ address, expiresAt: time.nullable(), active: z.boolean() }),
    ),
  }),
  "GET /v1/claims/:id/graph": z.array(
    z.union([
      object({ id: hash, core: coreSchema, parents: z.array(hash) }),
      object({
        id: hash,
        missing: z.literal(true),
        parents: z.array(hash).length(0),
      }),
    ]),
  ),
  "POST /v1/claims/:id/grant": grant.extend({ assetGranted: z.boolean() }),
  "POST /v1/claims/:id/anchor": object({ jobId: id }),
  "GET /v1/jobs/:id": object({
    id,
    owner: address,
    claimId: hash,
    state: z.enum([
      "queued",
      "submitted",
      "confirmed",
      "failed",
      "withdrawn",
      "orphaned",
      "pending",
    ]),
    result: text.nullable(),
    error: text.nullable(),
    attempts: count,
    updated: text.nullable(),
    txHash: hash.nullable(),
    nextAttempt: time,
    leaseUntil: time,
    registrationStatus: anchor.optional(),
  }),
  "POST /v1/claims/:id/withdraw": tx,
  "POST /v1/verify": report,
  "POST /v1/verify/c2pa": c2paReportSchema,
  "GET /v1/verify/c2pa/status": object({
    available: z.boolean(),
    version: z.literal("0.28.2"),
    reason: text.nullable(),
  }),
  "GET /v1/chain/status": z.union([
    object({ online: z.literal(false) }),
    object({
      chainId: count.positive(),
      identity: address,
      provenance: address,
      blockNumber: decimal,
      codeHash: hash,
      identityCodeHash: hash.optional(),
      height: decimal,
      index: object({ id: address, blockNumber: decimal, blockHash: hash })
        .nullable()
        .optional(),
    }),
  ]),
  "GET /v1/assets/page": object({
    items: z.array(asset),
    nextCursor: decimal.nullable(),
  }),
  "GET /v1/claims/page": object({
    items: z.array(claim),
    nextCursor: decimal.nullable(),
  }),
  "GET /v1/stats": object({ assets: count, claims: count }),
  "GET /v1/organizations": object({
    operator: z.boolean(),
    organizations: z.array(
      organization.extend({ role, membershipStatus: membership }),
    ),
  }),
  "POST /v1/organizations": object({ id, status: z.literal("pending") }),
  "GET /v1/operator/organizations": z.array(organization),
  "POST /v1/operator/organizations/:id/review": object({
    status: orgStatus.exclude(["pending"]),
  }),
  "GET /v1/organizations/:id": object({
    organization,
    members: z.array(object({ address, role, status: membership })),
    reviews: z.array(
      object({
        reviewer: address,
        status: orgStatus.exclude(["pending"]),
        reason: text,
        created: text,
      }),
    ),
  }),
  "POST /v1/organizations/:id/members": updated,
  "POST /v1/organizations/:id/accept": object({ accepted: z.literal(true) }),
  "POST /v1/organizations/:id/share": updated,
  "POST /v1/exports/preview": object({
    entries: count,
    uncompressedBytes: count,
    hiddenFields: z.array(text),
    hiddenParents: z.array(count),
    warning: text,
  }),
  "POST /v1/exports": object({ id, state: z.literal("queued") }),
  "GET /v1/exports/:id": object({
    id,
    state: exportState,
    progress: count.max(100),
    error: text.nullable(),
    bytes: count.nullable(),
    expires: time,
  }),
  "POST /v1/exports/:id/cancel": object({ cancelled: z.literal(true) }),
  "POST /v1/exports/:id/link": object({
    url: z.string().regex(/^\/v1\/export-download\/[a-f0-9]{64}$/),
    expires: time,
  }),
};
export const binaryContracts: Record<string, string> = {
  "GET /v1/assets/:digest/content": "image/*",
  "POST /v1/bundles": "application/zip",
  "GET /v1/exports/:id/content": "application/zip",
  "GET /v1/export-download/:token": "application/zip",
};
export const errorContract = object({
  error: object({ code: text, message: text }),
  requestId: text.optional(),
});
export const envelope = (schema: z.ZodType) => object({ data: schema });
export const responseDefinitions: Record<string, any> = {};
export function responseJSON(schema: z.ZodType) {
  const result = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  }) as Record<string, any>;
  delete result.$schema;
  const defs = result.$defs as Record<string, any> | undefined;
  if (defs) {
    const prefix =
      "Response_" + hashBytes(Buffer.from(JSON.stringify(defs))).slice(2, 18);
    const refs = Object.fromEntries(
      Object.keys(defs).map((name) => [
        `#/$defs/${name}`,
        `#/components/schemas/${prefix}_${name}`,
      ]),
    );
    function rewrite(node: any) {
      if (!node || typeof node !== "object") return;
      if (typeof node.$ref === "string" && refs[node.$ref])
        node.$ref = refs[node.$ref];
      Object.values(node).forEach(rewrite);
    }
    rewrite(result);
    for (const [name, definition] of Object.entries(defs))
      responseDefinitions[`${prefix}_${name}`] = definition;
    delete result.$defs;
  }
  return result;
}
export function validateResponse(
  method: string,
  route: string,
  status: number,
  payload: unknown,
) {
  if (
    status >= 400 &&
    !(route === "/health/ready" && status === 503 && (payload as any)?.data)
  )
    return errorContract.parse(payload);
  const schema =
    responseContracts[`${method === "HEAD" ? "GET" : method} ${route}`];
  if (!schema) throw Error("RESPONSE_CONTRACT_MISSING");
  return envelope(schema).parse(payload);
}
export function registerResponseContracts(app: FastifyInstance) {
  app.addHook("preSerialization", async (req, reply, payload) => {
    const safe = JSON.parse(
      JSON.stringify(payload, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
    try {
      return validateResponse(
        req.method,
        req.routeOptions.url ?? "",
        reply.statusCode,
        safe,
      );
    } catch {
      throw Object.assign(Error("RESPONSE_CONTRACT_VIOLATION"), {
        code: "RESPONSE_CONTRACT_VIOLATION",
        statusCode: 500,
      });
    }
  });
}
