import { createServer, createConnection, type Socket } from "node:net";
import { accessSync, constants, writeFileSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { archivedWorker } from "./archives.js";
import { ProcessJobs } from "./process-jobs.js";
import { ResourcePool } from "./resources.js";
import { receiveSandboxFrame, sandboxFrame } from "./sandbox-wire.js";
const inputSchema = z.strictObject({
  version: z.literal(1),
  method: z.literal("execute"),
  engineDigest: z.string().regex(/^0x[0-9a-f]{64}$/),
  operation: z.enum(["crop", "resize", "rotate", "compose"]),
  inputs: z.array(z.string().min(4).max(27962028)).min(1).max(2),
  params: z.strictObject({
    left: z.number().int().optional(),
    top: z.number().int().optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    angle: z.number().int().optional(),
  }),
});
const safeError = (e: unknown) =>
  e instanceof Error && /^[A-Z_]{3,80}$/.test(e.message)
    ? e.message
    : "MEDIA_SANDBOX_FAILED";
async function isolationProbe() {
  const protectedPaths = [
    "/etc/contentproof",
    "/var/lib/contentproof",
    "/root",
  ];
  const denied = protectedPaths.every((path) => {
    try {
      accessSync(path, constants.R_OK);
      return false;
    } catch (e) {
      return ["EACCES", "EPERM"].includes(
        (e as NodeJS.ErrnoException).code ?? "",
      );
    }
  });
  let writeDenied = false;
  const path = `/opt/contentproof/.sandbox-probe-${process.pid}`;
  try {
    writeFileSync(path, "synthetic-probe", { flag: "wx" });
    unlinkSync(path);
  } catch (e) {
    writeDenied = ["EROFS", "EACCES", "EPERM"].includes(
      (e as NodeJS.ErrnoException).code ?? "",
    );
  }
  const networkDenied = await new Promise<boolean>((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port: 3001 });
    s.setTimeout(1000);
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.once("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", (e) =>
      resolve(
        ["EAFNOSUPPORT", "EACCES", "EPERM"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        ),
      ),
    );
  });
  return {
    uid: process.getuid?.(),
    protectedPathsDenied: denied,
    writeDenied,
    networkDenied,
    secretEnvironmentEmpty: !Object.keys(process.env).some((k) =>
      /^(STORAGE_KEY|RELAYER_PRIVATE_KEY|VAULT_|CP_BACKUP_PASSWORD|NODE_OPTIONS|NODE_PATH)/.test(
        k,
      ),
    ),
  };
}
export function createMediaSandbox(catalogFile: string) {
  const pool = new ResourcePool(1, 0);
  let activeSocket: Socket | undefined;
  const server = createServer((socket) => {
    socket.on("error", () => {});
    if (activeSocket) {
      socket.end(sandboxFrame({ ok: false, error: "MEDIA_RESOURCE_LIMIT" }));
      return;
    }
    activeSocket = socket;
    let jobs: ProcessJobs | undefined;
    socket.setTimeout(22000, () => socket.destroy());
    socket.once("close", () => {
      jobs?.close();
      if (activeSocket === socket) activeSocket = undefined;
    });
    receiveSandboxFrame(socket, async (value) => {
      try {
        if (JSON.stringify(value) === '{"version":1,"method":"probe"}') {
          socket.end(sandboxFrame({ ok: true, probe: await isolationProbe() }));
          return;
        }
        const request = inputSchema.parse(value);
        const inputs = request.inputs.map((encoded) => {
          const bytes = Buffer.from(encoded, "base64");
          if (
            bytes.length < 1 ||
            bytes.length > 20 * 1024 * 1024 ||
            bytes.toString("base64") !== encoded
          )
            throw Error("MEDIA_INPUT_LIMIT");
          return bytes;
        });
        const worker = archivedWorker(request.engineDigest, catalogFile);
        if (!worker) {
          socket.end(sandboxFrame({ ok: true, available: false }));
          return;
        }
        jobs = new ProcessJobs(worker, pool);
        const bytes = await jobs.run<Buffer>({
          method: "execute",
          operation: request.operation,
          inputs,
          params: request.params,
        });
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.length < 1 ||
          bytes.length > 20 * 1024 * 1024
        )
          throw Error("MEDIA_SIZE_LIMIT");
        socket.end(
          sandboxFrame({
            ok: true,
            available: true,
            result: Buffer.from(bytes).toString("base64"),
          }),
        );
      } catch (e) {
        if (!socket.destroyed)
          socket.end(sandboxFrame({ ok: false, error: safeError(e) }));
      } finally {
        jobs?.close();
        if (activeSocket === socket) activeSocket = undefined;
      }
    });
  });
  return server;
}
