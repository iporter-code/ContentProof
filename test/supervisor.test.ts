import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

it.each([0, 7])(
  "supervisor fails when a required API process exits with code %s",
  async (code) => {
    mkdirSync("data/test-supervisor", { recursive: true });
    const root = mkdtempSync(resolve("data/test-supervisor/run-"));
    const save = (name: string, content: string) => {
      const path = resolve(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    };
    const rpc = createServer((_req, res) =>
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7a69" })),
    );
    await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
    // The RPC stub only serves the supervisor's readiness/code probes.
    rpc.removeAllListeners("request");
    rpc.on("request", (req, res) => {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () =>
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result:
              JSON.parse(body).method === "eth_chainId" ? "0x7a69" : "0x1234",
          }),
        ),
      );
    });
    const portProbe = createServer();
    await new Promise<void>((r) => portProbe.listen(0, "127.0.0.1", r));
    const port = (portProbe.address() as AddressInfo).port;
    await new Promise<void>((r) => portProbe.close(() => r()));
    const url = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
    save("package.json", '{"type":"module"}');
    save(
      "scripts/start-app.mjs",
      readFileSync("scripts/start-app.mjs", "utf8"),
    );
    save(
      "deployment.json",
      JSON.stringify({
        chainId: 31337,
        provenance: "0x0000000000000000000000000000000000001234",
      }),
    );
    save(
      "dist/server/packages/config/secrets.js",
      "export async function loadConfiguredSecrets() {}",
    );
    save(
      "dist/server/packages/config/index.js",
      `export const demoMode=false,dataPath=${JSON.stringify(root)},rpcUrl=${JSON.stringify(url)},rpcUrls=[rpcUrl],apiPort=${port},webPort=5173,chainId=31337;`,
    );
    save(
      "dist/server/packages/chain/index.js",
      "export async function validateDeployment() {}",
    );
    save(
      "dist/server/apps/api/main.js",
      `import {createServer} from 'node:http';const server=createServer((req,res)=>res.end('{}'));server.listen(${port},'127.0.0.1');setTimeout(()=>process.exit(${code}),1200);`,
    );
    const child = spawn(
      process.execPath,
      ["scripts/start-app.mjs", "--built"],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout!.on("data", (b) => (output += b));
    child.stderr!.on("data", (b) => (output += b));
    try {
      const exit = await new Promise<number | null>((done, reject) => {
        const timer = setTimeout(
          () => reject(Error("SUPERVISOR_DID_NOT_EXIT")),
          7000,
        );
        child.once("exit", (c) => {
          clearTimeout(timer);
          done(c);
        });
      });
      expect(exit).toBe(1);
      expect(output).toContain("api stopped unexpectedly");
    } finally {
      if (child.exitCode === null) child.kill();
      await new Promise<void>((r) => rpc.close(() => r()));
    }
  },
  10000,
);
