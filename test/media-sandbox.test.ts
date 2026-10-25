import { it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMediaSandbox } from "../packages/media/sandbox-service.js";
import { sandboxRequest } from "../packages/media/sandbox-wire.js";
import { executeArchived } from "../packages/media/archives.js";
const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
it("sandbox transport pins engines, rejects arbitrary paths, strips credentials and fails closed on disconnect", async () => {
  mkdirSync("data/test-media-sandbox", { recursive: true });
  const dir = mkdtempSync(resolve("data/test-media-sandbox/run-")),
    engine = resolve(dir, "engine"),
    id = "0x" + "ab".repeat(32);
  mkdirSync(engine);
  const code =
    "process.once('message',m=>{if(m.params.angle===90){process.exit(9);return;}process.send({ok:true,result:Buffer.from(Object.keys(process.env).filter(k=>/STORAGE_KEY|VAULT_|RELAYER_PRIVATE_KEY/.test(k)).length?'leaked':'historical result')});});";
  writeFileSync(resolve(engine, "worker.cjs"), code);
  const desc = {
    version: 1,
    engineDigest: id,
    platform: process.platform,
    arch: process.arch,
    worker: "worker.cjs",
    versions: { sharp: "synthetic" },
    files: { "worker.cjs": sha(code) },
  };
  writeFileSync(resolve(engine, "engine.json"), JSON.stringify(desc));
  const catalog = resolve(dir, "catalog.json");
  writeFileSync(
    catalog,
    JSON.stringify({
      version: 1,
      engines: [
        {
          engineDigest: id,
          directory: "engine",
          descriptorSha256: sha(readFileSync(resolve(engine, "engine.json"))),
        },
      ],
    }),
  );
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cp-media-${randomUUID()}`
      : resolve(dir, "sandbox.sock");
  const server = createMediaSandbox(catalog);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(path, () => done());
  });
  const old = {
    socket: process.env.CP_MEDIA_SANDBOX_SOCKET,
    required: process.env.CP_MEDIA_SANDBOX_REQUIRED,
    key: process.env.STORAGE_KEY,
  };
  try {
    process.env.CP_MEDIA_SANDBOX_SOCKET = path;
    process.env.CP_MEDIA_SANDBOX_REQUIRED = "true";
    process.env.STORAGE_KEY = "synthetic-do-not-inherit";
    expect(
      (
        await executeArchived(id, "rotate", [Buffer.from("input")], {
          angle: 0,
        })
      )?.toString(),
    ).toBe("historical result");
    const request = {
      version: 1,
      method: "execute",
      engineDigest: id,
      operation: "rotate",
      inputs: [Buffer.from("input").toString("base64")],
      params: { angle: 90 },
    };
    expect((await sandboxRequest(path, request)).error).toBe(
      "MEDIA_WORKER_CRASH",
    );
    expect(
      (await sandboxRequest(path, { ...request, worker: "/untrusted/code" }))
        .ok,
    ).toBe(false);
    expect(
      (
        await executeArchived(id, "rotate", [Buffer.from("input")], {
          angle: 0,
        })
      )?.toString(),
    ).toBe("historical result");
    writeFileSync(resolve(engine, "worker.cjs"), "modified");
    expect(
      (await sandboxRequest(path, { ...request, params: { angle: 0 } })).error,
    ).toBe("MEDIA_ARCHIVE_INTEGRITY_FAILED");
    await new Promise<void>((done) => server.close(() => done()));
    await expect(
      executeArchived(id, "rotate", [Buffer.from("input")], {}),
    ).rejects.toThrow("MEDIA_SANDBOX_UNAVAILABLE");
    delete process.env.CP_MEDIA_SANDBOX_SOCKET;
    await expect(
      executeArchived(id, "rotate", [Buffer.from("input")], {}),
    ).rejects.toThrow("MEDIA_SANDBOX_REQUIRED");
  } finally {
    server.close();
    for (const [name, value] of [
      ["CP_MEDIA_SANDBOX_SOCKET", old.socket],
      ["CP_MEDIA_SANDBOX_REQUIRED", old.required],
      ["STORAGE_KEY", old.key],
    ])
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
  }
});
