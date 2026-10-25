import type { FastifyInstance } from "fastify";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  createWriteStream,
  createReadStream,
  renameSync,
  unlinkSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { dataPath } from "../../packages/config/index.js";
import { disclose, jcs, hashBytes } from "../../packages/protocol/index.js";
import { writeBundle, type StreamEntry } from "../../packages/bundle/stream.js";
import {
  one,
  run,
  all,
  encrypt,
  decrypt,
  getClaim,
  assetAccess,
  objectPath,
  decryptObject,
  objectCipher,
  objectDecipher,
  audit,
} from "./store.js";
const inputSchema = z
  .object({
    target: z.string().regex(/^0x[0-9a-f]{64}$/),
    hideFields: z.array(z.string()).max(128).default([]),
    hideParents: z.array(z.number().int().min(0).max(7)).max(8).default([]),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
function entriesFor(who: string, input: Input): StreamEntry[] {
  const root = getClaim(input.target, who);
  if (
    input.hideFields.some(
      (f) => !root.privateFields.some((x) => x.path === f),
    ) ||
    input.hideParents.some((n) => n >= root.core.parentCount)
  )
    throw Error("INVALID_DISCLOSURE_SELECTION");
  const manifests = new Set<string>(),
    media = new Set<string>(),
    entries: StreamEntry[] = [];
  function walk(id: string, depth: number) {
    if (manifests.has(id)) return;
    if (depth > 64 || manifests.size >= 1000) throw Error("GRAPH_LIMIT");
    const full = getClaim(id, who),
      m = disclose(
        full,
        input.hideFields,
        id === input.target ? input.hideParents : [],
      ),
      bytes = jcs(m);
    manifests.add(id);
    entries.push({
      path: `manifests/${id}.json`,
      size: bytes.length,
      read: () => bytes,
    });
    if (!assetAccess(m.core.assetDigest, who)) throw Error("FORBIDDEN");
    if (!media.has(m.core.assetDigest)) {
      media.add(m.core.assetDigest);
      entries.push({
        path: `media/${m.core.assetDigest}`,
        size: m.core.byteLength,
        read: () => {
          if (!assetAccess(m.core.assetDigest, who)) throw Error("FORBIDDEN");
          return decryptObject(readFileSync(objectPath(m.core.assetDigest)));
        },
      });
    }
    for (const p of m.disclosure.parents)
      if (p.parent) walk(p.parent.claimId, depth + 1);
  }
  walk(input.target, 0);
  return entries;
}
export function registerExports(
  app: FastifyInstance,
  owner: (req: any) => string,
) {
  const root = resolve(dataPath, "exports");
  mkdirSync(root, { recursive: true });
  // The API holds an exclusive data-directory lock. No active export worker can
  // own these temporary files when this service starts after a crash.
  for (const name of readdirSync(root)) {
    if (/^[a-f0-9-]{36}\.cpe\.[a-f0-9-]{36}\.tmp$/.test(name))
      unlinkSync(resolve(root, name));
  }
  const path = (id: string) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("INVALID_EXPORT_ID");
    return resolve(root, `${id}.cpe`);
  };
  app.post("/v1/exports/preview", (req) => {
    const who = owner(req),
      input = inputSchema.parse(req.body),
      entries = entriesFor(who, input);
    return {
      data: {
        entries: entries.length,
        uncompressedBytes: entries.reduce((n, r) => n + r.size, 0),
        hiddenFields: input.hideFields,
        hiddenParents: input.hideParents,
        warning:
          "公开派生图和其他公开路径仍可能暴露隐藏内容；隐藏不等于不可推断。",
      },
    };
  });
  app.post("/v1/exports", (req) => {
    const who = owner(req),
      input = inputSchema.parse(req.body);
    entriesFor(who, input);
    if (
      Number(
        one(
          "SELECT COUNT(*) AS n FROM exports WHERE owner=? AND state IN ('queued','running','completed') AND expires>?",
          who,
          Date.now(),
        )?.n,
      ) >= 5
    )
      throw Error("EXPORT_QUOTA_LIMIT");
    const id = randomUUID(),
      now = Date.now();
    run(
      "INSERT INTO exports(id,owner,input,state,created,expires) VALUES(?,?,?,'queued',?,?)",
      id,
      who,
      encrypt(input),
      now,
      now + 3600000,
    );
    return { data: { id, state: "queued" } };
  });
  app.get<{ Params: { id: string } }>("/v1/exports/:id", (req) => {
    const row = one(
      "SELECT id,state,progress,error,bytes,expires FROM exports WHERE id=? AND owner=?",
      req.params.id,
      owner(req),
    );
    if (!row) throw Error("EXPORT_NOT_FOUND");
    return { data: row };
  });
  app.post<{ Params: { id: string } }>("/v1/exports/:id/cancel", (req) => {
    const who = owner(req),
      row = one(
        "SELECT * FROM exports WHERE id=? AND owner=?",
        req.params.id,
        who,
      );
    if (!row) throw Error("EXPORT_NOT_FOUND");
    run("UPDATE exports SET state='cancelled',lease=NULL WHERE id=?", row.id);
    run("DELETE FROM export_links WHERE exportId=?", row.id);
    if (existsSync(path(row.id))) unlinkSync(path(row.id));
    audit(who, "export-cancel", row.id);
    return { data: { cancelled: true } };
  });
  function download(id: string, reply: any) {
    const row = one("SELECT * FROM exports WHERE id=?", id);
    if (!row || row.state !== "completed" || row.expires < Date.now())
      throw Error("EXPORT_NOT_READY");
    entriesFor(row.owner, decrypt<Input>(row.input));
    const p = path(id),
      file = Buffer.alloc(40),
      fd = openSync(p, "r");
    try {
      if (readSync(fd, file, 0, 40, 0) !== 40)
        throw Error("INVALID_ENCRYPTED_OBJECT");
    } finally {
      closeSync(fd);
    }
    const { decipher, offset } = objectDecipher(file),
      stream = createReadStream(p, { start: offset });
    stream.on("error", (error) => decipher.destroy(error));
    return reply
      .type("application/zip")
      .header("Content-Disposition", 'attachment; filename="contentproof.zip"')
      .send(stream.pipe(decipher));
  }
  app.get<{ Params: { id: string } }>(
    "/v1/exports/:id/content",
    (req, reply) => {
      if (
        !one(
          "SELECT id FROM exports WHERE id=? AND owner=?",
          req.params.id,
          owner(req),
        )
      )
        throw Error("EXPORT_NOT_FOUND");
      return download(req.params.id, reply);
    },
  );
  app.post<{ Params: { id: string } }>("/v1/exports/:id/link", (req) => {
    const who = owner(req),
      row = one(
        "SELECT * FROM exports WHERE id=? AND owner=?",
        req.params.id,
        who,
      );
    if (!row || row.state !== "completed" || row.expires < Date.now())
      throw Error("EXPORT_NOT_READY");
    const token = randomBytes(32).toString("hex"),
      expires = Math.min(row.expires, Date.now() + 300000);
    run(
      "INSERT INTO export_links VALUES(?,?,?)",
      hashBytes(Buffer.from(token)),
      row.id,
      expires,
    );
    audit(who, "export-link", row.id);
    return { data: { url: `/v1/export-download/${token}`, expires } };
  });
  app.get<{ Params: { token: string } }>(
    "/v1/export-download/:token",
    (req, reply) => {
      const row = one(
        "SELECT * FROM export_links WHERE tokenHash=? AND expires>?",
        hashBytes(Buffer.from(req.params.token)),
        Date.now(),
      );
      if (!row) throw Error("EXPORT_NOT_FOUND");
      return download(row.exportId, reply);
    },
  );
  let busy = false,
    closing = false;
  let task: Promise<void> | undefined;
  async function tick() {
    if (busy || closing) return;
    busy = true;
    try {
      run("DELETE FROM export_links WHERE expires<?", Date.now());
      for (const old of all(
        "SELECT id FROM exports WHERE expires<?",
        Date.now(),
      )) {
        run("UPDATE exports SET state='expired',lease=NULL WHERE id=?", old.id);
        if (existsSync(path(old.id))) unlinkSync(path(old.id));
      }
      const job = one(
        "SELECT * FROM exports WHERE expires>? AND (state='queued' OR state='running' AND leaseUntil<?) ORDER BY created LIMIT 1",
        Date.now(),
        Date.now(),
      );
      if (!job) return;
      const lease = randomUUID(),
        taken = run(
          "UPDATE exports SET state='running',lease=?,leaseUntil=?,attempts=attempts+1 WHERE id=? AND (state='queued' OR state='running' AND leaseUntil<?)",
          lease,
          Date.now() + 30000,
          job.id,
          Date.now(),
        );
      if (!taken.changes) return;
      const temp = `${path(job.id)}.${lease}.tmp`,
        { iv, cipher, magic } = objectCipher();
      try {
        if (job.attempts >= 3) throw Error("EXPORT_ATTEMPT_LIMIT");
        const entries = entriesFor(job.owner, decrypt<Input>(job.input));
        // Prefix layout matches encrypted objects; fill the authentication tag only
        // after the encrypted stream is closed, then atomically publish the file.
        const output = createWriteStream(temp, { flags: "wx", mode: 0o600 });
        output.write(Buffer.concat([magic, iv, Buffer.alloc(16)]));
        const piping = pipeline(cipher, output);
        piping.catch(() => {});
        try {
          await writeBundle(
            decrypt<Input>(job.input).target,
            entries,
            cipher,
            (progress) => {
              if (closing) throw Error("EXPORT_INTERRUPTED");
              const r = run(
                "UPDATE exports SET progress=?,leaseUntil=? WHERE id=? AND lease=? AND state='running'",
                progress,
                Date.now() + 30000,
                job.id,
                lease,
              );
              if (!r.changes) throw Error("EXPORT_CANCELLED");
            },
          );
          await piping;
        } catch (error) {
          cipher.destroy();
          await piping.catch(() => {});
          throw error;
        }
        const fd = openSync(temp, "r+");
        try {
          writeSync(fd, cipher.getAuthTag(), 0, 16, magic.length + 12);
        } finally {
          closeSync(fd);
        }
        if (
          one("SELECT state FROM exports WHERE id=? AND lease=?", job.id, lease)
            ?.state !== "running"
        )
          throw Error("EXPORT_CANCELLED");
        renameSync(temp, path(job.id));
        run(
          "UPDATE exports SET state='completed',progress=100,bytes=?,lease=NULL,leaseUntil=0 WHERE id=? AND lease=?",
          statSync(path(job.id)).size,
          job.id,
          lease,
        );
        audit(job.owner, "export-completed", job.id);
      } catch (error) {
        if (existsSync(temp)) unlinkSync(temp);
        run(
          "UPDATE exports SET state=?,error=?,lease=NULL,leaseUntil=0 WHERE id=? AND lease=? AND state='running'",
          closing ? "queued" : "failed",
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "EXPORT_FAILED",
          job.id,
          lease,
        );
      }
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => {
    if (busy) return;
    task = tick();
    task.catch(() =>
      app.log.warn({ code: "EXPORT_WORKER_FAILED" }, "Export worker failed"),
    );
  }, 500);
  app.addHook("onClose", async () => {
    closing = true;
    clearInterval(timer);
    await task;
  });
}
