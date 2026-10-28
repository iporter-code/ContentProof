import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { typedData } from "../packages/protocol/index.js";

export const delay = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
export const resultsDir = resolve(
  process.env.CP_RESULTS_DIR ?? "data/app/results",
);
export class LocalHarness {
  readonly dir: string;
  readonly base: string;
  readonly rpcURL: string;
  readonly env: NodeJS.ProcessEnv;
  child?: ChildProcess;
  private log = "";
  diagnostics() {
    return {
      supervisorPid: this.child?.pid,
      exitCode: this.child?.exitCode,
      signal: this.child?.signalCode,
      log: this.log,
    };
  }
  constructor(
    name: string,
    port: number,
    rpcPort: number,
    readonly projectRoot = process.cwd(),
  ) {
    mkdirSync("data/engineering-runs", { recursive: true });
    this.dir = mkdtempSync(resolve(`data/engineering-runs/${name}-`));
    this.base = `http://127.0.0.1:${port}`;
    this.rpcURL = `http://127.0.0.1:${rpcPort}`;
    this.env = {
      ...process.env,
      DATA_DIR: this.dir,
      PORT: String(port),
      CHAIN_PORT: String(rpcPort),
      RPC_URL: this.rpcURL,
      RPC_URLS: "",
      CHAIN_ID: "31337",
      CHAIN_MODE: "",
      DEMO_MODE: "false",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      STORAGE_KEY: "",
      STORAGE_KEY_FILE: "",
      RELAYER_PRIVATE_KEY: "",
      RELAYER_PRIVATE_KEY_FILE: "",
      CONFIRMATIONS: "1",
      AUTH_AUDIENCE: this.base,
      REGISTRATION_MODE: "open",
    };
    for (const key of [
      "STORAGE_KEY",
      "STORAGE_KEY_FILE",
      "RELAYER_PRIVATE_KEY",
      "RELAYER_PRIVATE_KEY_FILE",
      "STORAGE_KEY_VAULT_PATH",
      "STORAGE_KEY_VAULT_REF_FILE",
      "STORAGE_KEY_VAULT_TRANSIT_FILE",
      "STORAGE_KEY_VAULT_VERSION",
      "RELAYER_PRIVATE_KEY_VAULT_PATH",
      "RELAYER_PRIVATE_KEY_VAULT_REF_FILE",
      "RELAYER_PRIVATE_KEY_VAULT_TRANSIT_FILE",
      "RELAYER_PRIVATE_KEY_VAULT_VERSION",
      "VAULT_ADDR",
      "VAULT_TOKEN_FILE",
      "VAULT_NAMESPACE",
    ])
      delete this.env[key];
  }
  async start() {
    // Never reuse a pre-existing service/chain on the dedicated test ports.
    for (const url of [this.base + "/health/live", this.rpcURL]) {
      let occupied = false;
      try {
        await fetch(url, { signal: AbortSignal.timeout(500) });
        occupied = true;
      } catch {}
      assert(!occupied, "TEST_PORT_ALREADY_IN_USE");
    }
    this.log = "";
    this.child = fork(
      resolve(this.projectRoot, "scripts/start-app.mjs"),
      ["--built"],
      {
        cwd: this.projectRoot,
        execArgv: [],
        env: this.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let ownerReady = false;
    this.child.on("message", (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "contentproof-ready" &&
        "port" in message &&
        message.port === Number(this.env.PORT)
      )
        ownerReady = true;
    });
    for (const stream of [this.child.stdout!, this.child.stderr!])
      stream.on("data", (b) => {
        this.log = (this.log + b).slice(-16000);
      });
    for (let i = 0; i < 200; i++) {
      if (this.child.exitCode !== null)
        throw Error(this.log || "TEST_SERVICE_EXITED");
      try {
        if (
          ownerReady &&
          (
            await fetch(this.base + "/health/ready", {
              signal: AbortSignal.timeout(500),
            })
          ).ok &&
          (await fetch(this.base + "/", { signal: AbortSignal.timeout(500) }))
            .ok
        )
          return;
      } catch {}
      await delay(200);
    }
    throw Error(this.log || "TEST_SERVICE_START_TIMEOUT");
  }
  async stop() {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    const ended = new Promise<void>((res, rej) => {
      const timer = setTimeout(
        () => rej(Error("TEST_GRACEFUL_STOP_TIMEOUT")),
        65000,
      );
      c.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && signal === null) res();
        else rej(Error(`TEST_SERVICE_STOP_FAILED:${signal ?? code}`));
      });
    });
    c.send("shutdown");
    await ended;
  }
  async rpc(method: string, params: unknown[] = []) {
    const r = await fetch(this.rpcURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await r.json();
    if (body.error) throw Error(body.error.message);
    return body.result;
  }
  async call(path: string, token = "", body?: unknown, method?: string) {
    const r = await this.response(path, token, body, method);
    const json = await r.json();
    if (!r.ok)
      throw Error(`${r.status}:${json.error?.code ?? "REQUEST_FAILED"}`);
    return json.data;
  }
  response(path: string, token = "", body?: unknown, method?: string) {
    return fetch(this.base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined && !(body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  }
  async identity() {
    const account = privateKeyToAccount(generatePrivateKey());
    const login = async () => {
      const c = await this.call("/v1/auth/challenge", "", {
        address: account.address,
      });
      return (
        await this.call("/v1/auth/verify", "", {
          id: c.id,
          signature: await account.signMessage({ message: c.message }),
        })
      ).token as string;
    };
    const token = await login();
    await this.call("/v1/profile", token, { name: "隔离工程验收身份" });
    return { account, token, login };
  }
  async sign(
    draftId: string,
    identity: Awaited<ReturnType<LocalHarness["identity"]>>,
  ) {
    const p = await this.call(
      `/v1/drafts/${draftId}/prepare`,
      identity.token,
      {},
    );
    return this.call(`/v1/drafts/${draftId}/signatures`, identity.token, {
      signature: await identity.account.signTypedData(
        typedData(p.core, p.domain),
      ),
    });
  }
  async confirmed(jobId: string, token: string, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const j = await this.call(`/v1/jobs/${jobId}`, token);
      if (j.state === "confirmed") return j;
      if (["failed", "withdrawn"].includes(j.state))
        throw Error(j.error ?? j.state);
      await delay(400);
    }
    throw Error("TEST_ANCHOR_TIMEOUT");
  }
}
export function saveReport(name: string, data: unknown) {
  if (!/^[a-z][a-z0-9-]{0,64}$/.test(name)) throw Error("INVALID_REPORT_NAME");
  mkdirSync(resultsDir, { recursive: true });
  const target = resolve(resultsDir, `${name}.json`),
    temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2));
  renameSync(temp, target);
}
