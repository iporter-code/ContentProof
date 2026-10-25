import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { all, one, run, audit, db } from "./store.js";
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase());
const roles = z.enum(["owner", "admin", "editor", "viewer"]);
export function operator(who: string) {
  return (process.env.OPERATOR_ADDRESSES ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .includes(who);
}
function member(
  orgId: string,
  who: string,
  allowed: string[] = ["owner", "admin"],
) {
  const row = one(
    "SELECT * FROM organization_members WHERE orgId=? AND address=? AND status='active'",
    orgId,
    who,
  );
  if (!row || !allowed.includes(row.role)) throw Error("FORBIDDEN");
  return row;
}
export function registerOrganizations(
  app: FastifyInstance,
  owner: (req: any) => string,
) {
  app.get("/v1/organizations", (req) => {
    const who = owner(req);
    return {
      data: {
        operator: operator(who),
        organizations: all(
          "SELECT o.*,m.role,m.status AS membershipStatus FROM organizations o JOIN organization_members m ON m.orgId=o.id WHERE m.address=? ORDER BY o.created DESC",
          who,
        ),
      },
    };
  });
  app.post("/v1/organizations", (req) => {
    const who = owner(req),
      input = z
        .object({
          name: z.string().trim().min(2).max(100),
          evidenceDigest: z.string().regex(/^0x[0-9a-f]{64}$/),
        })
        .strict()
        .parse(req.body),
      id = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      run(
        "INSERT INTO organizations VALUES(?,?,?,?,?,?)",
        id,
        input.name,
        "pending",
        who,
        input.evidenceDigest,
        new Date().toISOString(),
      );
      run(
        "INSERT INTO organization_members VALUES(?,?,?,?)",
        id,
        who,
        "owner",
        "active",
      );
      audit(who, "organization-apply", id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { data: { id, status: "pending" } };
  });
  app.get("/v1/operator/organizations", (req) => {
    const who = owner(req);
    if (!operator(who)) throw Error("FORBIDDEN");
    return { data: all("SELECT * FROM organizations ORDER BY created DESC") };
  });
  app.post<{ Params: { id: string } }>(
    "/v1/operator/organizations/:id/review",
    (req) => {
      const who = owner(req);
      if (!operator(who)) throw Error("FORBIDDEN");
      const org = one("SELECT * FROM organizations WHERE id=?", req.params.id);
      if (!org) throw Error("ORGANIZATION_NOT_FOUND");
      if (org.applicant === who) throw Error("SELF_REVIEW_FORBIDDEN");
      const input = z
        .object({
          status: z.enum(["approved", "rejected", "suspended"]),
          reason: z.string().trim().min(5).max(1000),
        })
        .strict()
        .parse(req.body);
      db.exec("BEGIN IMMEDIATE");
      try {
        run(
          "UPDATE organizations SET status=? WHERE id=?",
          input.status,
          org.id,
        );
        run(
          "INSERT INTO organization_reviews(orgId,reviewer,status,reason,created) VALUES(?,?,?,?,?)",
          org.id,
          who,
          input.status,
          input.reason,
          new Date().toISOString(),
        );
        audit(who, `organization-${input.status}`, org.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return { data: { status: input.status } };
    },
  );
  app.get<{ Params: { id: string } }>("/v1/organizations/:id", (req) => {
    const who = owner(req);
    member(req.params.id, who, ["owner", "admin", "editor", "viewer"]);
    return {
      data: {
        organization: one(
          "SELECT * FROM organizations WHERE id=?",
          req.params.id,
        ),
        members: all(
          "SELECT address,role,status FROM organization_members WHERE orgId=?",
          req.params.id,
        ),
        reviews: all(
          "SELECT reviewer,status,reason,created FROM organization_reviews WHERE orgId=?",
          req.params.id,
        ),
      },
    };
  });
  app.post<{ Params: { id: string } }>(
    "/v1/organizations/:id/members",
    (req) => {
      const who = owner(req),
        self = member(req.params.id, who),
        input = z
          .object({ address, role: roles, remove: z.boolean().default(false) })
          .strict()
          .parse(req.body),
        existing = one(
          "SELECT * FROM organization_members WHERE orgId=? AND address=?",
          req.params.id,
          input.address,
        );
      if (
        self.role !== "owner" &&
        (input.role === "owner" ||
          input.role === "admin" ||
          ["owner", "admin"].includes(existing?.role))
      )
        throw Error("FORBIDDEN");
      if (
        existing?.role === "owner" &&
        (input.remove || input.role !== "owner") &&
        Number(
          one(
            "SELECT COUNT(*) AS n FROM organization_members WHERE orgId=? AND role='owner' AND status='active'",
            req.params.id,
          )?.n,
        ) < 2
      )
        throw Error("LAST_OWNER_REQUIRED");
      if (input.remove)
        run(
          "DELETE FROM organization_members WHERE orgId=? AND address=?",
          req.params.id,
          input.address,
        );
      else
        run(
          "INSERT INTO organization_members VALUES(?,?,?,?) ON CONFLICT(orgId,address) DO UPDATE SET role=excluded.role",
          req.params.id,
          input.address,
          input.role,
          "invited",
        );
      audit(
        who,
        input.remove ? "member-remove" : "member-invite-or-role",
        `${req.params.id}:${input.address}`,
      );
      return { data: { updated: true } };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/organizations/:id/accept",
    (req) => {
      const who = owner(req),
        r = run(
          "UPDATE organization_members SET status='active' WHERE orgId=? AND address=? AND status='invited'",
          req.params.id,
          who,
        );
      if (!r.changes) throw Error("INVITATION_NOT_FOUND");
      audit(who, "member-accept", req.params.id);
      return { data: { accepted: true } };
    },
  );
  app.post<{ Params: { id: string } }>("/v1/organizations/:id/share", (req) => {
    const who = owner(req);
    member(req.params.id, who, ["owner", "admin", "editor"]);
    if (
      one("SELECT status FROM organizations WHERE id=?", req.params.id)
        ?.status !== "approved"
    )
      throw Error("ORGANIZATION_NOT_APPROVED");
    const input = z
      .object({
        digest: z.string().regex(/^0x[0-9a-f]{64}$/),
        claimId: z
          .string()
          .regex(/^0x[0-9a-f]{64}$/)
          .optional(),
        permission: z.enum(["read", "edit"]).default("read"),
        revoke: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    if (
      !one(
        "SELECT digest FROM asset_owners WHERE digest=? AND owner=?",
        input.digest,
        who,
      )
    )
      throw Error("FORBIDDEN");
    if (
      input.claimId &&
      !one("SELECT id FROM claims WHERE id=? AND owner=?", input.claimId, who)
    )
      throw Error("FORBIDDEN");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (input.revoke) {
        run(
          "DELETE FROM organization_assets WHERE orgId=? AND digest=?",
          req.params.id,
          input.digest,
        );
        if (input.claimId)
          run(
            "DELETE FROM organization_claims WHERE orgId=? AND claimId=?",
            req.params.id,
            input.claimId,
          );
      } else {
        run(
          "INSERT INTO organization_assets VALUES(?,?,?) ON CONFLICT(orgId,digest) DO UPDATE SET permission=excluded.permission",
          req.params.id,
          input.digest,
          input.permission,
        );
        if (input.claimId)
          run(
            "INSERT OR IGNORE INTO organization_claims VALUES(?,?)",
            req.params.id,
            input.claimId,
          );
      }
      audit(
        who,
        input.revoke ? "organization-unshare" : "organization-share",
        `${req.params.id}:${input.digest}`,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { data: { updated: true } };
  });
}
