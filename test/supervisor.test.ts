import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { LocalHarness } from "../scripts/local-harness.js";

it("harness waits for its owner to finish startup before stopping a listening API", async () => {
  mkdirSync("data/test-supervisor", { recursive: true });
  const root = mkdtempSync(resolve("data/test-supervisor/ready-"));
  mkdirSync(resolve(root, "scripts"));
  writeFileSync(resolve(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    resolve(root, "scripts/start-app.mjs"),
    `import {createServer} from 'node:http';
const server=createServer((_req,res)=>res.end('{}'));
server.listen(Number(process.env.PORT),'127.0.0.1');
setTimeout(()=>{
 process.on('message',m=>{if(m==='shutdown')server.close(()=>process.exit(0));});
 process.send({type:'contentproof-ready',port:Number(process.env.PORT)});
},800);`,
  );
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const h = new LocalHarness("owner-ready", port, port, root);
  try {
    const started = Date.now();
    await h.start();
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    await h.stop();
    expect(h.diagnostics().exitCode).toBe(0);
    expect(h.diagnostics().signal).toBe(null);
  } finally {
    if (h.child?.exitCode === null) h.child.kill();
  }
}, 8000);

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
      "scripts/process-shutdown.mjs",
      readFileSync("scripts/process-shutdown.mjs", "utf8"),
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
