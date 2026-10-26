import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, sep, extname } from "node:path";
import {
  getAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { trustedProxies } from "../../packages/config/proxy.js";
import { browserSecurityHeaders } from "../../packages/config/browser-security.js";
import {
  prepare,
  disclose,
  claimId,
  salt,
  hashBytes,
  typedData,
  signer,
  verify,
  ZERO,
  manifestSchema,
  type Core,
  type Manifest,
  type PrivateManifest,
  type Field,
  type Parent,
} from "../../packages/protocol/index.js";
import {
  demoAccount,
  domain,
  nonce,
  anchor,
  observe,
  publicClient,
  deployment,
  wallet,
  withRelayer,
  validateDeployment,
} from "../../packages/chain/index.js";
import {
  demoMode,
  apiPort,
  audience,
  origins,
} from "../../packages/config/index.js";
import {
  inspect,
  execute,
  reproduce,
  engineDigest,
  type Params,
  stopMediaWorkers,
} from "../../packages/media/isolated.js";
import { importBundle, exportBundle } from "../../packages/bundle/index.js";
import {
  db,
  one,
  all,
  run,
  encrypt,
  decrypt,
  objectPath,
  assetAccess,
  getClaim,
  audit,
  encryptObject,
  decryptObject,
  assetEdit,
  releaseStoreLock,
  transaction,
  writeGrant,
  expireGrants,
} from "./store.js";
import { registerOrganizations } from "./organizations.js";
import { registerExports } from "./exports.js";
import {
  registerPagination,
  assetPredicate,
  claimPredicate,
} from "./pagination.js";
import { mediaPool } from "../../packages/media/resources.js";
import { registerResponseContracts } from "./contracts.js";
import { tickIndexer } from "../../packages/chain/indexer.js";
import { registerOperations } from "./operations.js";
import {
  verifyC2pa,
  c2paAvailability,
  C2PA_MAX_BYTES,
} from "../../packages/c2pa/index.js";

const DEMO = demoMode;
const HOST = process.env.HOST ?? "127.0.0.1";
if (DEMO && HOST !== "127.0.0.1")
  throw new Error("Demo signing must bind to 127.0.0.1");
if (!DEMO && HOST !== "127.0.0.1" && !process.env.STORAGE_KEY)
  throw Error("External deployment requires STORAGE_KEY");
export const app = Fastify({
  trustProxy: trustedProxies(),
  logger: {
    level: "warn",
    redact: [
      "req.headers.authorization",
      "req.body",
      'res.headers["set-cookie"]',
    ],
  },
  bodyLimit: 2 * 1024 * 1024,
  requestTimeout: 30000,
});
registerResponseContracts(app);
app.addHook("onSend", async (_req, reply, payload) => {
  for (const [name, value] of Object.entries(browserSecurityHeaders))
    reply.header(name, value);
  return payload;
});
app.setNotFoundHandler((req, reply) =>
  reply.code(404).send({
    error: { code: "NOT_FOUND", message: "NOT_FOUND" },
    requestId: req.id,
  }),
);
await app.register(cors, {
  origin: [...origins, audience],
  methods: ["GET", "POST", "PATCH"],
});
await app.register(rateLimit, {
  max: 180,
  allowList: (req) =>
    req.method === "GET" && /^\/health\/(live|ready)(?:\?|$)/.test(req.url),
  timeWindow: "1 minute",
  errorResponseBuilder: (_req, context) =>
    Object.assign(Error("RATE_LIMIT"), {
      code: "RATE_LIMIT",
      statusCode: context.statusCode,
    }),
});
await app.register(multipart, {
  limits: { files: 1, fileSize: 128 * 1024 * 1024, parts: 8 },
});
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && ![...origins, audience].includes(origin)) {
    await reply.code(403).send({
      error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin denied" },
    });
    return;
  }
});
let inFlight = 0;
const resourceCounts = { media: 0, verify: 0 },
  resourceRequests = new WeakMap<object, "media" | "verify">();
const metrics = { requests: 0, errors: 0, totalMilliseconds: 0 };
const admitted = new WeakSet<object>();
app.addHook("onRequest", async (req, reply) => {
  const url = req.url.split("?")[0],
    kind =
      req.method === "POST" &&
      (url === "/v1/assets" || url === "/v1/drafts/transform")
        ? "media"
        : url === "/v1/verify" || url === "/v1/verify/c2pa"
          ? "verify"
          : null;
  if (kind) {
    if (resourceCounts[kind] >= 2) {
      await reply.code(429).send({
        error: { code: "RESOURCE_BUSY", message: "资源繁忙，请稍后重试" },
      });
      return;
    }
    resourceCounts[kind]++;
    resourceRequests.set(req, kind);
  }
  if (inFlight >= 8) {
    await reply
      .code(429)
      .send({ error: { code: "CONCURRENCY_LIMIT", message: "请稍后重试" } });
    return;
  }
  inFlight++;
  admitted.add(req);
});
app.addHook("onResponse", async (req, reply) => {
  if (admitted.delete(req)) inFlight--;
  const kind = resourceRequests.get(req);
  if (kind) {
    resourceCounts[kind]--;
    resourceRequests.delete(req);
  }
  metrics.requests++;
  metrics.totalMilliseconds += reply.elapsedTime;
});
app.setErrorHandler((error: any, req, reply) => {
  metrics.errors++;
  req.log.warn(
    {
      code:
        error.code ??
        (/^[A-Z0-9_]{3,100}$/.test(error.message ?? "")
          ? error.message
          : "REQUEST_FAILED"),
      requestId: req.id,
    },
    "Request failed",
  );
  const code =
    error instanceof z.ZodError
      ? "INVALID_INPUT"
      : /^[A-Z0-9_]{3,100}$/.test(String(error.code ?? error.message))
        ? String(error.code ?? error.message)
        : "REQUEST_FAILED";
  const status =
    code.startsWith("MEDIA_WORKER_") ||
    /^(C2PA_BINARY_|C2PA_RUNTIME_|C2PA_VERIFIER_)/.test(code)
      ? 503
      : code === "RESPONSE_CONTRACT_VIOLATION" || code === "REQUEST_FAILED"
        ? 500
        : error.statusCode === 429
          ? 429
          : code === "UNAUTHORIZED"
            ? 401
            : code === "FORBIDDEN" || code.endsWith("_FORBIDDEN")
              ? 403
              : code.includes("NOT_FOUND")
                ? 404
                : code.includes("LIMIT") || code === "FST_REQ_FILE_TOO_LARGE"
                  ? 413
                  : 400;
  reply
    .code(status)
    .send({ error: { code, message: code }, requestId: req.id });
});
const ok = (data: unknown) => ({ data });
async function successfulReceipt(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw Error("TRANSACTION_REVERTED");
  return receipt;
}
app.get("/v1/openapi.json", (_, reply) =>
  reply
    .type("application/json")
    .send(readFileSync(resolve("docs/openapi.json"))),
);
function owner(req: any): string {
  const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const row = one(
    "SELECT owner,expires FROM sessions WHERE token=?",
    hashBytes(Buffer.from(token)),
  );
  if (!row || row.expires < Date.now()) throw new Error("UNAUTHORIZED");
  return row.owner;
}
const session = (address: string) => {
  const token = randomBytes(32).toString("hex");
  run(
    "INSERT INTO sessions VALUES(?,?,?)",
    hashBytes(Buffer.from(token)),
    address.toLowerCase(),
    Date.now() + 3600000,
  );
  return { token, address: getAddress(address), demoMode: DEMO };
};
const param = (req: any, key: string) => String(req.params[key]);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
registerOrganizations(app, owner);
registerPagination(app, owner);
app.get("/v1/system/metrics", (req) => {
  owner(req);
  return ok({
    ...metrics,
    inFlight,
    resources: resourceCounts,
    media: mediaPool.status(),
    memory: process.memoryUsage(),
    uptimeSeconds: process.uptime(),
    alerts: [
      ...(workerError ? [workerError] : []),
      ...(indexerError ? [indexerError] : []),
    ],
  });
});
function storeAsset(
  bytes: Uint8Array,
  meta: Awaited<ReturnType<typeof inspect>>,
  who: string,
) {
  const path = objectPath(meta.digest),
    temp = `${path}.${randomUUID()}.tmp`;
  const owned = one(
    "SELECT digest FROM asset_owners WHERE digest=? AND owner=?",
    meta.digest,
    who,
  );
  const used = Number(
    one(
      "SELECT COALESCE(SUM(json_extract(a.meta,'$.size')),0) AS n FROM assets a JOIN asset_owners o ON o.digest=a.digest WHERE o.owner=?",
      who,
    )?.n ?? 0,
  );
  if (
    !owned &&
    used + bytes.length >
      Number(process.env.USER_STORAGE_BYTES ?? 512 * 1024 * 1024)
  )
    throw Error("USER_STORAGE_LIMIT");
  writeFileSync(temp, encryptObject(bytes), { mode: 0o600 });
  renameSync(temp, path);
  db.exec("BEGIN");
  try {
    run(
      "INSERT OR IGNORE INTO assets VALUES(?,?)",
      meta.digest,
      JSON.stringify(meta),
    );
    run("INSERT OR IGNORE INTO asset_acl VALUES(?,?)", meta.digest, who);
    run("INSERT OR IGNORE INTO asset_owners VALUES(?,?)", meta.digest, who);
    run(
      "DELETE FROM asset_grant_expiries WHERE digest=? AND owner=?",
      meta.digest,
      who,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return meta;
}
function ownedAsset(digest: string, who: string): Buffer {
  if (!assetAccess(digest, who)) throw new Error("FORBIDDEN");
  return decryptObject(readFileSync(objectPath(digest)));
}
type Draft = {
  assetDigest: string;
  operation: Core["operation"];
  params?: Params;
  parents: string[];
  fields: Record<string, unknown>;
  prepared?: { core: Core; fields: Field[]; parents: Parent[] };
  domain?: Manifest["domain"];
};
function draft(id: string, who: string): Draft {
  const row = one("SELECT json FROM drafts WHERE id=? AND owner=?", id, who);
  if (!row) throw new Error("DRAFT_NOT_FOUND");
  return decrypt(row.json);
}
function assertDraftAccess(
  d: Pick<Draft, "assetDigest" | "parents">,
  who: string,
) {
  if (!assetAccess(d.assetDigest, who) || !assetEdit(d.assetDigest, who))
    throw Error("FORBIDDEN");
  for (const id of d.parents) {
    const parent = getClaim(id, who);
    if (
      !assetAccess(parent.core.assetDigest, who) ||
      !assetEdit(parent.core.assetDigest, who)
    )
      throw Error("FORBIDDEN");
  }
}
function assertClaimSourceAccess(m: PrivateManifest, who: string) {
  assertDraftAccess(
    {
      assetDigest: m.core.assetDigest,
      parents: m.privateParents.map((p) => p.claimId),
    },
    who,
  );
}
function saveDraft(who: string, d: Draft) {
  const id = randomUUID();
  run("INSERT INTO drafts(id,owner,json) VALUES(?,?,?)", id, who, encrypt(d));
  audit(who, "draft", id);
  return {
    id,
    ...d,
    prepared: undefined,
    engineDigest: d.params ? engineDigest : ZERO,
  };
}
const fieldsSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/), z.unknown())
  .refine((v) => Object.keys(v).length <= 120);
app.get("/health/live", () => ok({ alive: true }));
app.get("/health/ready", async (_, reply) => {
  let chain = false;
  try {
    const d = await validateDeployment();
    chain =
      (await publicClient.getChainId()) === d.chainId &&
      !!(await publicClient.getCode({ address: d.provenance }));
  } catch {}
  if (!chain) reply.code(503);
  return ok({ database: !!one("SELECT 1 AS value"), chain, demoMode: DEMO });
});
app.get("/v1/identities", () =>
  ok({
    demoMode: DEMO,
    identities: DEMO
      ? [1, 2, 3].map((i) => ({
          index: i,
          address: demoAccount(i).address,
          label: ["", "创作者 A", "编辑机构 B", "发布机构 C"][i],
        }))
      : all(
          "SELECT address,name AS label,epoch FROM profiles ORDER BY created",
        ),
  }),
);
app.post("/v1/demo/login", async (req) => {
  if (!DEMO) throw new Error("FORBIDDEN");
  const { index } = z
    .object({ index: z.number().int().min(1).max(3) })
    .parse(req.body);
  return ok(session(demoAccount(index).address));
});
app.post("/v1/auth/challenge", async (req) => {
  const { address } = z.object({ address: addressSchema }).parse(req.body);
  const id = randomBytes(24).toString("hex"),
    expires = Date.now() + 120000;
  const message = `ContentProof authentication\nAudience: ${audience}\nAddress: ${getAddress(address)}\nNonce: ${id}\nExpires: ${new Date(expires).toISOString()}`;
  run(
    "INSERT INTO challenges(id,address,message,expires) VALUES(?,?,?,?)",
    id,
    address.toLowerCase(),
    message,
    expires,
  );
  return ok({ id, message, expires });
});
app.post("/v1/auth/verify", async (req) => {
  const { id, signature } = z
    .object({
      id: z.string().length(48),
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
    })
    .parse(req.body);
  const c = one("SELECT * FROM challenges WHERE id=?", id);
  if (
    !c ||
    c.consumed ||
    c.expires < Date.now() ||
    !c.message.startsWith("ContentProof authentication\n")
  )
    throw new Error("UNAUTHORIZED");
  const recovered = await recoverMessageAddress({
    message: c.message,
    signature: signature as Hex,
  });
  if (recovered.toLowerCase() !== c.address) throw new Error("UNAUTHORIZED");
  const result = run(
    "UPDATE challenges SET consumed=1 WHERE id=? AND consumed=0",
    id,
  );
  if (Number(result.changes) !== 1) throw new Error("UNAUTHORIZED");
  return ok(session(recovered));
});
app.post("/v1/auth/logout", (req) => {
  owner(req);
  run(
    "DELETE FROM sessions WHERE token=?",
    hashBytes(
      Buffer.from(String(req.headers.authorization).replace(/^Bearer /, "")),
    ),
  );
  return ok({ loggedOut: true });
});
app.get("/v1/profile", (req) => {
  const who = owner(req);
  return ok({
    address: getAddress(who),
    profile: one("SELECT * FROM profiles WHERE address=?", who) ?? null,
    demoMode: DEMO,
  });
});
app.post("/v1/profile", async (req) => {
  const who = owner(req);
  const { name } = z
    .object({ name: z.string().trim().min(2).max(80) })
    .parse(req.body);
  if (!one("SELECT * FROM profiles WHERE address=?", who)) {
    if (
      process.env.REGISTRATION_MODE === "closed" ||
      (HOST !== "127.0.0.1" && process.env.REGISTRATION_MODE !== "open")
    )
      throw Error("REGISTRATION_REQUIRES_OPERATOR_APPROVAL");
    const d = deployment();
    const record = (await publicClient.readContract({
      address: d.identity,
      abi: d.identityAbi,
      functionName: "keys",
      args: [getAddress(who), 1n],
    })) as [Address, bigint, bigint, bigint];
    if (record[1] === 0n) {
      const tx = await withRelayer(() =>
        wallet().writeContract({
          address: d.identity,
          abi: d.identityAbi,
          functionName: "authorizeKey",
          args: [getAddress(who), 1n, getAddress(who)],
        }),
      );
      await successfulReceipt(tx);
    }
    run(
      "INSERT INTO profiles(address,name,created) VALUES(?,?,?)",
      who,
      name,
      new Date().toISOString(),
    );
  } else run("UPDATE profiles SET name=? WHERE address=?", name, who);
  audit(who, "profile-updated", who);
  return ok({ registered: true });
});
app.get("/v1/keys", async (req) => {
  const who = owner(req),
    d = deployment();
  const epochs = new Set<string>([
    "1",
    one("SELECT epoch FROM profiles WHERE address=?", who)?.epoch ?? "1",
  ]);
  // Known epochs are stored at creation; querying never treats a label as identity proof.
  for (const row of all(
    "SELECT objectId FROM audit WHERE owner=? AND action='key-authorize'",
    who,
  ))
    epochs.add(row.objectId);
  return ok(
    await Promise.all(
      [...epochs].map(async (epoch) => ({
        epoch,
        record: await publicClient.readContract({
          address: d.identity,
          abi: d.identityAbi,
          functionName: "keys",
          args: [getAddress(who), BigInt(epoch)],
        }),
      })),
    ),
  );
});
app.post("/v1/keys/challenge", (req) => {
  const who = owner(req),
    input = z
      .object({
        action: z.enum(["authorize", "retire", "revoke"]),
        epoch: z.string().regex(/^[1-9]\d{0,20}$/),
        signer: addressSchema.optional(),
      })
      .parse(req.body);
  const id = randomBytes(24).toString("hex"),
    expires = Date.now() + 120000;
  const message = JSON.stringify({
    purpose: "contentproof-key-action/1",
    audience,
    issuer: who,
    ...input,
    id,
    expires,
  });
  run(
    "INSERT INTO challenges(id,address,message,expires) VALUES(?,?,?,?)",
    id,
    who,
    message,
    expires,
  );
  return ok({ id, message });
});
app.post("/v1/keys/action", async (req) => {
  const who = owner(req),
    { id, signature } = z
      .object({
        id: z.string().length(48),
        signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      })
      .parse(req.body);
  const c = one("SELECT * FROM challenges WHERE id=?", id);
  if (!c || c.address !== who || c.consumed || c.expires < Date.now())
    throw Error("UNAUTHORIZED");
  const action = JSON.parse(c.message);
  if (
    action.purpose !== "contentproof-key-action/1" ||
    (
      await recoverMessageAddress({
        message: c.message,
        signature: signature as Hex,
      })
    ).toLowerCase() !== who
  )
    throw Error("INVALID_ACTION_SIGNATURE");
  const consumed = run(
    "UPDATE challenges SET consumed=1 WHERE id=? AND consumed=0",
    id,
  );
  if (!Number(consumed.changes)) throw Error("ACTION_ALREADY_USED");
  const d = deployment(),
    method =
      action.action === "authorize"
        ? "authorizeKey"
        : action.action === "retire"
          ? "retireKey"
          : "revokeKey";
  const args =
    action.action === "authorize"
      ? [
          getAddress(who),
          BigInt(action.epoch),
          getAddress(action.signer ?? who),
        ]
      : [getAddress(who), BigInt(action.epoch)];
  const tx = await withRelayer(() =>
    wallet().writeContract({
      address: d.identity,
      abi: d.identityAbi,
      functionName: method,
      args,
    }),
  );
  await successfulReceipt(tx);
  if (action.action === "authorize")
    run("UPDATE profiles SET epoch=? WHERE address=?", action.epoch, who);
  audit(who, `key-${action.action}`, action.epoch);
  return ok({ txHash: tx });
});
app.post("/v1/assets/:digest/revoke", (req) => {
  const who = owner(req),
    digest = param(req, "digest");
  if (
    !one(
      "SELECT owner FROM asset_owners WHERE digest=? AND owner=?",
      digest,
      who,
    )
  )
    throw Error("FORBIDDEN");
  const { address } = z.object({ address: addressSchema }).parse(req.body);
  if (address.toLowerCase() === who) throw Error("CANNOT_REVOKE_OWNER");
  run(
    "DELETE FROM asset_acl WHERE digest=? AND owner=?",
    digest,
    address.toLowerCase(),
  );
  run(
    "DELETE FROM asset_editors WHERE digest=? AND owner=?",
    digest,
    address.toLowerCase(),
  );
  audit(who, "asset-access-revoked", digest);
  return ok({ revoked: true });
});
app.post("/v1/claims/:id/revoke", (req) => {
  const who = owner(req),
    id = param(req, "id"),
    m = getClaim(id, who);
  if (m.core.issuer.toLowerCase() !== who) throw Error("FORBIDDEN");
  const { address } = z.object({ address: addressSchema }).parse(req.body);
  if (address.toLowerCase() === who) throw Error("CANNOT_REVOKE_OWNER");
  run(
    "DELETE FROM claim_acl WHERE id=? AND owner=?",
    id,
    address.toLowerCase(),
  );
  audit(who, "claim-access-revoked", id);
  return ok({
    revoked: true,
    notice: "原始素材访问权需单独撤销，已下载内容无法收回",
  });
});
app.get("/v1/audit", (req) =>
  ok(
    all(
      "SELECT action,objectId,created FROM audit WHERE owner=? ORDER BY id DESC LIMIT 200",
      owner(req),
    ),
  ),
);
app.get("/v1/system/health", (req) => {
  owner(req);
  return ok({ workerError, indexerError });
});
app.post("/v1/assets", async (req) => {
  const who = owner(req),
    part = await req.file({ limits: { fileSize: 20 * 1024 * 1024 } });
  if (!part) throw new Error("FILE_REQUIRED");
  const bytes = await part.toBuffer();
  const expected = part.fields.expectedDigest;
  if (
    expected &&
    (Array.isArray(expected) ||
      expected.type !== "field" ||
      !/^0x[0-9a-f]{64}$/.test(String(expected.value)) ||
      expected.value !== hashBytes(bytes))
  )
    throw Error("UPLOAD_DIGEST_MISMATCH");
  const meta = await inspect(bytes);
  return ok(storeAsset(bytes, meta, who));
});
app.get("/v1/assets", (req) => {
  const who = owner(req);
  return ok(
    all(
      `SELECT a.meta FROM assets a WHERE ${assetPredicate} ORDER BY a.rowid DESC LIMIT 200`,
      who,
      who,
    ).map((r) => {
      const meta = JSON.parse(r.meta);
      return { ...meta, canEdit: assetEdit(meta.digest, who) };
    }),
  );
});
app.get("/v1/assets/:digest", (req) => {
  const digest = param(req, "digest");
  ownedAsset(digest, owner(req));
  return ok(
    JSON.parse(one("SELECT meta FROM assets WHERE digest=?", digest)!.meta),
  );
});
app.get("/v1/assets/:digest/content", (req, reply) => {
  const digest = param(req, "digest"),
    bytes = ownedAsset(digest, owner(req)),
    meta = JSON.parse(
      one("SELECT meta FROM assets WHERE digest=?", digest)!.meta,
    );
  return reply
    .type(meta.mediaType)
    .header("X-Content-Type-Options", "nosniff")
    .send(bytes);
});
app.post("/v1/assets/:digest/grant", (req) => {
  const digest = param(req, "digest");
  const who = owner(req);
  if (
    !one(
      "SELECT owner FROM asset_owners WHERE digest=? AND owner=?",
      digest,
      who,
    )
  )
    throw Error("FORBIDDEN");
  const { address, permission, expiresAt } = z
    .object({
      address: addressSchema,
      permission: z.enum(["read", "edit"]).default("read"),
      expiresAt: z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER)
        .nullable()
        .default(null),
    })
    .parse(req.body);
  transaction(() =>
    writeGrant("asset", digest, address.toLowerCase(), expiresAt, permission),
  );
  audit(
    who,
    "asset-granted",
    `${digest}:${address.toLowerCase()}:${permission}:${expiresAt ?? "permanent"}`,
  );
  return ok({ granted: true, expiresAt });
});
app.post("/v1/drafts/import", (req) => {
  const who = owner(req),
    input = z
      .object({
        assetDigest: z.string(),
        operation: z.enum(["import", "ai-declaration"]).default("import"),
        fields: fieldsSchema.default({}),
      })
      .parse(req.body);
  ownedAsset(input.assetDigest, who);
  if (!assetEdit(input.assetDigest, who)) throw Error("FORBIDDEN");
  return ok(saveDraft(who, { ...input, parents: [] }));
});
app.post("/v1/drafts/transform", async (req) => {
  const who = owner(req);
  const input = z
    .object({
      parents: z.array(z.string()).min(1).max(2),
      operation: z.enum(["crop", "resize", "rotate", "compose"]),
      params: z
        .object({
          left: z.number().optional(),
          top: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          angle: z.number().optional(),
        })
        .strict(),
      fields: fieldsSchema.default({}),
    })
    .parse(req.body);
  const parents = input.parents.map((id) => getClaim(id, who));
  if (parents.some((m) => !assetEdit(m.core.assetDigest, who)))
    throw Error("FORBIDDEN");
  const bytes = await execute(
    input.operation,
    parents.map((m) => ownedAsset(m.core.assetDigest, who)),
    input.params,
  );
  const meta = storeAsset(bytes, await inspect(bytes), who);
  return ok(saveDraft(who, { assetDigest: meta.digest, ...input }));
});
app.patch("/v1/drafts/:id", (req) => {
  const who = owner(req),
    id = param(req, "id"),
    d = draft(id, who);
  const { fields, revision } = z
    .object({ fields: fieldsSchema, revision: z.number().int().positive() })
    .parse(req.body);
  if (d.prepared) throw new Error("PREPARED_DRAFT_IMMUTABLE");
  d.fields = fields;
  const updated = run(
    "UPDATE drafts SET json=?,revision=revision+1 WHERE id=? AND owner=? AND revision=?",
    encrypt(d),
    id,
    who,
    revision,
  );
  if (Number(updated.changes) !== 1) throw new Error("REVISION_CONFLICT");
  return ok({ id, revision: revision + 1 });
});
app.post("/v1/drafts/:id/prepare", async (req) => {
  const who = owner(req),
    id = param(req, "id"),
    d = draft(id, who);
  assertDraftAccess(d, who);
  const options = z
    .object({
      refresh: z.boolean().optional(),
      keyEpoch: z
        .string()
        .regex(/^[1-9]\d*$/)
        .optional(),
    })
    .parse(req.body ?? {});
  if (options.refresh && d.prepared) {
    const oldId = claimId({ core: d.prepared.core, domain: d.domain! });
    if (one("SELECT id FROM claims WHERE id=?", oldId))
      audit(who, "supersede-preparation", oldId);
    delete d.prepared;
    delete d.domain;
  }
  if (d.prepared && d.domain)
    return ok({
      core: d.prepared.core,
      domain: d.domain,
      typedData: typedData(d.prepared.core, d.domain),
      fields: d.prepared.fields,
      parents: d.prepared.parents,
    });
  const meta = JSON.parse(
    one("SELECT meta FROM assets WHERE digest=?", d.assetDigest)!.meta,
  );
  const fields = Object.entries({
    ...d.fields,
    ...(d.params ? { "operation.params": d.params } : {}),
  }).map(([path, value]) => ({ path, value, salt: salt() }));
  const parents = d.parents.map((id, index) => {
    const m = getClaim(id, who);
    return {
      claimId: id as `0x${string}`,
      assetDigest: m.core.assetDigest as `0x${string}`,
      role: `input-${index}`,
      salt: salt(),
    };
  });
  d.prepared = prepare(
    {
      protocol: "contentproof/1",
      assetDigest: d.assetDigest,
      mediaType: meta.mediaType,
      byteLength: meta.size,
      operation: d.operation,
      engineDigest: d.params ? engineDigest : ZERO,
      issuer: getAddress(who),
      keyEpoch:
        options.keyEpoch ??
        one("SELECT epoch FROM profiles WHERE address=?", who)?.epoch ??
        "1",
      nonce: await nonce(
        getAddress(who),
        BigInt(
          options.keyEpoch ??
            one("SELECT epoch FROM profiles WHERE address=?", who)?.epoch ??
            "1",
        ),
      ),
      deadline: String(Math.floor(Date.now() / 1000) + 86400),
    },
    fields,
    parents,
  );
  d.domain = domain();
  assertDraftAccess(d, who);
  run("UPDATE drafts SET json=? WHERE id=?", encrypt(d), id);
  return ok({
    core: d.prepared.core,
    domain: d.domain,
    typedData: typedData(d.prepared.core, d.domain),
    fields: d.prepared.fields,
    parents: d.prepared.parents,
  });
});
app.post("/v1/drafts/:id/signatures", async (req) => {
  const who = owner(req),
    d = draft(param(req, "id"), who);
  if (!d.prepared || !d.domain) throw new Error("PREPARE_FIRST");
  assertDraftAccess(d, who);
  const { signature } = z
    .object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) })
    .parse(req.body);
  const full = {
    core: d.prepared.core,
    domain: d.domain,
    signature: signature as Hex,
    privateFields: d.prepared.fields,
    privateParents: d.prepared.parents,
  } as PrivateManifest;
  full.disclosure = disclose(full).disclosure;
  const recovered = await signer(full);
  const dpl = deployment();
  const active = await publicClient.readContract({
    address: dpl.identity,
    abi: dpl.identityAbi,
    functionName: "isKeyActive",
    args: [getAddress(who), BigInt(full.core.keyEpoch), recovered],
  });
  if (!active) throw new Error("INVALID_SIGNER");
  const id = claimId(full);
  if (
    (await nonce(getAddress(who), BigInt(full.core.keyEpoch))) !==
    full.core.nonce
  )
    throw Error("NONCE_CONFLICT_REFRESH_REQUIRED");
  if (BigInt(full.core.deadline) < BigInt(Math.floor(Date.now() / 1000)))
    throw Error("SIGNATURE_EXPIRED_REFRESH_REQUIRED");
  assertDraftAccess(d, who);
  run("INSERT OR IGNORE INTO claims VALUES(?,?,?)", id, who, encrypt(full));
  run("INSERT OR IGNORE INTO claim_acl VALUES(?,?)", id, who);
  audit(who, "signed", id);
  return ok({ id, manifest: disclose(full) });
});
app.post("/v1/demo/sign/:id", async (req) => {
  if (!DEMO) throw new Error("FORBIDDEN");
  const who = owner(req),
    d = draft(param(req, "id"), who);
  if (!d.prepared || !d.domain) throw new Error("PREPARE_FIRST");
  const index = [1, 2, 3].find(
    (i) => demoAccount(i).address.toLowerCase() === who,
  );
  if (!index) throw new Error("FORBIDDEN");
  return ok({
    signature: await demoAccount(index).signTypedData(
      typedData(d.prepared.core, d.domain),
    ),
  });
});
app.get("/v1/claims", (req) => {
  const who = owner(req);
  return ok(
    all(
      `SELECT c.id,c.encrypted,c.owner FROM claims c WHERE ${claimPredicate} ORDER BY c.rowid DESC LIMIT 200`,
      who,
      who,
    ).map((row) => {
      const m = decrypt<PrivateManifest>(row.encrypted);
      return { id: row.id, owner: row.owner, core: m.core };
    }),
  );
});
app.get("/v1/claims/:id", async (req) => {
  const who = owner(req),
    full = getClaim(param(req, "id"), who);
  return ok({
    manifest: disclose(full),
    chain: await observe(full, await signer(full)),
    fields: full.privateFields.map((f) => f.path),
    grants:
      full.core.issuer.toLowerCase() === who
        ? all(
            "SELECT p.owner AS address,e.expires AS expiresAt FROM claim_acl p LEFT JOIN claim_grant_expiries e ON e.id=p.id AND e.owner=p.owner WHERE p.id=? AND p.owner<>?",
            param(req, "id"),
            who,
          ).map((g) => ({
            ...g,
            active: g.expiresAt === null || g.expiresAt > Date.now(),
          }))
        : [],
  });
});
app.get("/v1/claims/:id/graph", (req) => {
  const who = owner(req),
    nodes: any[] = [],
    seen = new Set<string>();
  function walk(id: string, depth: number) {
    if (seen.has(id)) return;
    if (depth > 64 || seen.size >= 1000) throw new Error("GRAPH_LIMIT");
    seen.add(id);
    try {
      const m = getClaim(id, who);
      nodes.push({
        id,
        core: m.core,
        parents: m.privateParents.map((p) => p.claimId),
      });
    } catch {
      nodes.push({ id, missing: true, parents: [] });
      return;
    }
    const current = nodes[nodes.length - 1];
    for (const parent of current.parents) walk(parent, depth + 1);
  }
  walk(param(req, "id"), 0);
  return ok(nodes);
});
app.post("/v1/claims/:id/grant", (req) => {
  const who = owner(req),
    id = param(req, "id");
  const m = getClaim(id, who);
  if (m.core.issuer.toLowerCase() !== who) throw new Error("FORBIDDEN");
  const { address, permission, expiresAt } = z
    .object({
      address: addressSchema,
      permission: z.enum(["read", "edit"]).default("read"),
      expiresAt: z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER)
        .nullable()
        .default(null),
    })
    .parse(req.body);
  const ownsAsset = !!one(
    "SELECT digest FROM asset_owners WHERE digest=? AND owner=?",
    m.core.assetDigest,
    who,
  );
  transaction(() => {
    writeGrant("claim", id, address.toLowerCase(), expiresAt);
    if (ownsAsset)
      writeGrant(
        "asset",
        m.core.assetDigest,
        address.toLowerCase(),
        expiresAt,
        permission,
      );
  });
  audit(
    who,
    "claim-granted",
    `${id}:${address.toLowerCase()}:${permission}:${expiresAt ?? "permanent"}`,
  );
  return ok({ granted: true, assetGranted: ownsAsset, expiresAt });
});
app.post("/v1/claims/:id/anchor", async (req) => {
  const who = owner(req),
    id = param(req, "id");
  const m = getClaim(id, who);
  if (m.core.issuer.toLowerCase() !== who) throw new Error("FORBIDDEN");
  assertClaimSourceAccess(m, who);
  const existing = one("SELECT * FROM jobs WHERE claimId=?", id);
  const current = await observe(m, await signer(m));
  assertClaimSourceAccess(m, who);
  if (current.anchor === "withdrawn") throw Error("CLAIM_WITHDRAWN");
  if (existing) {
    if (
      existing.state === "failed" ||
      existing.state === "orphaned" ||
      (existing.state === "confirmed" && current.anchor !== "confirmed")
    )
      run(
        "UPDATE jobs SET state='queued',error=NULL,result=NULL,txHash=NULL,leaseUntil=0,attempts=0,nextAttempt=0 WHERE id=? AND state IN ('failed','orphaned','confirmed')",
        existing.id,
      );
    return ok({ jobId: existing.id });
  }
  const jobId = randomUUID();
  run(
    "INSERT INTO jobs(id,owner,claimId,state,updated) VALUES(?,?,?,?,?)",
    jobId,
    who,
    id,
    "queued",
    new Date().toISOString(),
  );
  return ok({ jobId });
});
app.get("/v1/jobs/:id", async (req) => {
  const job = one(
    "SELECT * FROM jobs WHERE id=? AND owner=?",
    param(req, "id"),
    owner(req),
  );
  if (!job) throw new Error("JOB_NOT_FOUND");
  if (["confirmed", "orphaned", "withdrawn", "pending"].includes(job.state)) {
    const m = getClaim(job.claimId, job.owner),
      status = await observe(m, await signer(m));
    job.registrationStatus = status.anchor;
    if (status.anchor === "confirmed") job.state = "confirmed";
    else if (status.anchor === "pending") job.state = "pending";
    else if (status.anchor === "withdrawn") job.state = "withdrawn";
    else if (status.anchor === "absent" || status.anchor === "mismatch")
      job.state = "orphaned";
    run("UPDATE jobs SET state=? WHERE id=?", job.state, job.id);
  }
  return ok(job);
});
app.post("/v1/claims/:id/withdraw", async (req) => {
  const who = owner(req),
    id = param(req, "id"),
    m = getClaim(id, who);
  if (m.core.issuer.toLowerCase() !== who) throw new Error("FORBIDDEN");
  if (!DEMO) {
    const input = z
      .object({
        deadline: z.string().regex(/^\d+$/),
        signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      })
      .parse(req.body);
    const d = deployment();
    const tx = await withRelayer(() =>
      wallet().writeContract({
        address: d.provenance,
        abi: d.provenanceAbi,
        functionName: "invalidateClaimBySignature",
        args: [id, BigInt(input.deadline), input.signature],
      }),
    );
    await successfulReceipt(tx);
    run("UPDATE jobs SET state='withdrawn' WHERE claimId=?", id);
    return ok({ txHash: tx });
  }
  const index = [1, 2, 3].find(
    (i) => demoAccount(i).address.toLowerCase() === who,
  )!;
  const d = deployment();
  const tx = await wallet(index).writeContract({
    address: d.provenance,
    abi: d.provenanceAbi,
    functionName: "invalidateClaim",
    args: [id, hashBytes(Buffer.from("issuer-withdrawal"))],
  });
  await successfulReceipt(tx);
  run("UPDATE jobs SET state='withdrawn' WHERE claimId=?", id);
  return ok({ txHash: tx });
});
app.post("/v1/bundles", async (req, reply) => {
  const who = owner(req),
    input = z
      .object({
        target: z.string(),
        hideFields: z.array(z.string()).max(128).default([]),
        hideParents: z.array(z.number().int().min(0).max(7)).max(8).default([]),
      })
      .parse(req.body);
  const manifests = new Map<string, Manifest>(),
    files = new Map<string, Uint8Array>();
  function walk(id: string, depth: number) {
    if (manifests.has(id)) return;
    if (depth > 64 || manifests.size >= 1000) throw new Error("GRAPH_LIMIT");
    const full = getClaim(id, who),
      m = disclose(
        full,
        input.hideFields,
        id === input.target ? input.hideParents : [],
      );
    manifests.set(id, m);
    files.set(m.core.assetDigest, ownedAsset(m.core.assetDigest, who));
    for (const slot of m.disclosure.parents)
      if (slot.parent) walk(slot.parent.claimId, depth + 1);
  }
  walk(input.target, 0);
  const bytes = exportBundle({ target: input.target, manifests, files });
  audit(who, "export", input.target);
  return reply
    .type("application/zip")
    .header("Content-Disposition", 'attachment; filename="contentproof.zip"')
    .send(Buffer.from(bytes));
});
app.get("/v1/verify/c2pa/status", async (req) => {
  owner(req);
  return ok(c2paAvailability());
});
app.post("/v1/verify/c2pa", async (req) => {
  owner(req);
  const part = await req.file({
    limits: { fileSize: C2PA_MAX_BYTES, files: 1, parts: 1 },
  });
  if (!part) throw Error("FILE_REQUIRED");
  return ok(await verifyC2pa(await part.toBuffer()));
});
app.post("/v1/verify", async (req) => {
  owner(req);
  const part = await req.file();
  if (!part) throw new Error("FILE_REQUIRED");
  const bundle = await importBundle(await part.toBuffer());
  return ok(await verify(bundle.target, { ...bundle, observe, reproduce }));
});
app.get("/v1/chain/status", async () => {
  try {
    const d = deployment();
    return ok({
      ...d,
      identityAbi: undefined,
      provenanceAbi: undefined,
      height: String(await publicClient.getBlockNumber({ cacheTime: 0 })),
      index: one("SELECT * FROM checkpoints WHERE id=?", d.provenance),
    });
  } catch {
    return ok({ online: false });
  }
});
let busy = false;
let workerError: string | null = null,
  indexerError: string | null = null;
let workerTask: Promise<void> | undefined;
let workerHeartbeat = Date.now();
registerOperations(app, owner, () => ({
  workerError,
  indexerError,
  workerAge: Date.now() - workerHeartbeat,
  inFlight,
  mediaQueued: mediaPool.status().queued,
}));
async function runWorker() {
  if (busy) return;
  busy = true;
  try {
    run("DELETE FROM sessions WHERE expires<?", Date.now());
    expireGrants();
    run("DELETE FROM challenges WHERE expires<?", Date.now() - 86400000);
    const job = one(
      "SELECT * FROM jobs WHERE (state='queued' OR state='submitted' AND leaseUntil<?) AND nextAttempt<=? ORDER BY rowid LIMIT 1",
      Date.now(),
      Date.now(),
    );
    if (job) {
      const taken = run(
        "UPDATE jobs SET state='submitted',attempts=attempts+1,updated=?,leaseUntil=? WHERE id=? AND (state='queued' OR state='submitted' AND leaseUntil<?)",
        new Date().toISOString(),
        Date.now() + 60000,
        job.id,
        Date.now(),
      );
      if (!Number(taken.changes)) return;
      try {
        const result = await withRelayer(() => {
          const m = getClaim(job.claimId, job.owner);
          assertClaimSourceAccess(m, job.owner);
          return anchor(m, 0, (hash) =>
            run("UPDATE jobs SET txHash=? WHERE id=?", hash, job.id),
          );
        });
        run(
          "UPDATE jobs SET state='confirmed',result=?,error=NULL WHERE id=?",
          JSON.stringify(result),
          job.id,
        );
      } catch (error) {
        const code =
          error instanceof Error
            ? error.message.split("\n")[0].slice(0, 100)
            : "ANCHOR_ERROR";
        const retry =
          job.attempts < 4 &&
          !/NONCE|EXPIRED|WITHDRAWN|SIGNER|FORBIDDEN/.test(code);
        run(
          "UPDATE jobs SET state=?,error=?,nextAttempt=?,leaseUntil=0 WHERE id=?",
          retry ? "queued" : "failed",
          code,
          Date.now() + Math.min(30000, 1000 * 2 ** job.attempts),
          job.id,
        );
        app.log.warn({ jobId: job.id, code }, "Anchor failed");
      }
    }
    try {
      await tickIndexer();
      indexerError = null;
    } catch {
      indexerError = "INDEXER_FAILED";
      app.log.warn({ code: indexerError }, "Indexer failed");
    }
    workerError = null;
  } catch {
    workerError = "WORKER_FAILED";
    app.log.warn({ code: workerError }, "Worker failed");
  } finally {
    workerHeartbeat = Date.now();
    busy = false;
  }
}
const timer = setInterval(() => {
  if (!busy) workerTask = runWorker();
}, 700);
app.addHook("onClose", async () => {
  clearInterval(timer);
  stopMediaWorkers();
  await workerTask;
  db.close();
  releaseStoreLock();
});
registerExports(app, owner);
const webRoot = resolve("dist/web");
if (existsSync(resolve(webRoot, "index.html")))
  app.get("/*", (req, reply) => {
    const path = req.url.split("?")[0];
    if (path.startsWith("/v1/") || path.startsWith("/health/"))
      return reply
        .code(404)
        .send({ error: { code: "NOT_FOUND", message: "NOT_FOUND" } });
    const file = resolve(webRoot, `.${path}`);
    if (!file.startsWith(webRoot + sep) && file !== webRoot)
      return reply.code(403).send();
    const target = extname(file) ? file : resolve(webRoot, "index.html");
    if (!existsSync(target)) return reply.code(404).send();
    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
    };
    return reply
      .type(types[extname(target)] ?? "application/octet-stream")
      .header("X-Content-Type-Options", "nosniff")
      .send(readFileSync(target));
  });
if (process.env.NODE_ENV !== "test") {
  await app.listen({ host: HOST, port: apiPort });
  console.log(
    `ContentProof API http://${HOST}:${process.env.PORT ?? 3001} (demo signing ${DEMO ? "ON, local test keys only" : "OFF"})`,
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
process.on("message", (m) => {
  if (m === "shutdown") void app.close().then(() => process.exit(0));
});
process.on("disconnect", () => {
  void app.close().then(() => process.exit(0));
});
