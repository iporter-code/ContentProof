import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, decrypt, assetEdit } from "./store.js";
import type { PrivateManifest } from "../../packages/protocol/index.js";
import {
  activeAssetGrant,
  activeClaimGrant,
} from "../../packages/persistence/access.js";
export const assetPredicate = `EXISTS(SELECT 1 FROM asset_acl p WHERE p.digest=a.digest AND p.owner=? AND ${activeAssetGrant}) OR EXISTS(SELECT 1 FROM organization_assets p JOIN organization_members m ON m.orgId=p.orgId JOIN organizations o ON o.id=p.orgId WHERE p.digest=a.digest AND m.address=? AND m.status='active' AND o.status='approved')`;
export const claimPredicate = `EXISTS(SELECT 1 FROM claim_acl p WHERE p.id=c.id AND p.owner=? AND ${activeClaimGrant}) OR EXISTS(SELECT 1 FROM organization_claims p JOIN organization_members m ON m.orgId=p.orgId JOIN organizations o ON o.id=p.orgId WHERE p.claimId=c.id AND m.address=? AND m.status='active' AND o.status='approved')`;
export function registerPagination(
  app: FastifyInstance,
  owner: (req: any) => string,
) {
  const query = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z
        .string()
        .regex(/^[1-9][0-9]{0,15}$/)
        .optional(),
    })
    .strict();
  app.get("/v1/assets/page", (req) => {
    const who = owner(req),
      q = query.parse(req.query),
      rows = all(
        `SELECT a.meta,a.rowid AS sequence FROM assets a WHERE (${assetPredicate}) AND a.rowid<? ORDER BY a.rowid DESC LIMIT ?`,
        who,
        who,
        q.cursor ?? String(Number.MAX_SAFE_INTEGER),
        q.limit + 1,
      );
    return {
      data: {
        items: rows.slice(0, q.limit).map((r) => {
          const meta = JSON.parse(r.meta);
          return { ...meta, canEdit: assetEdit(meta.digest, who) };
        }),
        nextCursor:
          rows.length > q.limit ? String(rows[q.limit - 1].sequence) : null,
      },
    };
  });
  app.get("/v1/claims/page", (req) => {
    const who = owner(req),
      q = query.parse(req.query),
      rows = all(
        `SELECT c.*,c.rowid AS sequence FROM claims c WHERE (${claimPredicate}) AND c.rowid<? ORDER BY c.rowid DESC LIMIT ?`,
        who,
        who,
        q.cursor ?? String(Number.MAX_SAFE_INTEGER),
        q.limit + 1,
      );
    return {
      data: {
        items: rows.slice(0, q.limit).map((r) => ({
          id: r.id,
          owner: r.owner,
          core: decrypt<PrivateManifest>(r.encrypted).core,
        })),
        nextCursor:
          rows.length > q.limit ? String(rows[q.limit - 1].sequence) : null,
      },
    };
  });
  app.get("/v1/stats", (req) => {
    const who = owner(req);
    return {
      data: {
        assets: one(
          `SELECT COUNT(*) AS n FROM assets a WHERE ${assetPredicate}`,
          who,
          who,
        )?.n,
        claims: one(
          `SELECT COUNT(*) AS n FROM claims c WHERE ${claimPredicate}`,
          who,
          who,
        )?.n,
      },
    };
  });
}
