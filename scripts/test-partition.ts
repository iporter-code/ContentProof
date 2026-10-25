import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { delay, saveReport } from "./local-harness.js";
const file = resolve("data/qbft-network/compose.json"),
  config = JSON.parse(readFileSync(file, "utf8"));
assert.equal(config.name, "ccf-qbft");
const network = config.networks.qbft.name;
assert.equal(network, "ccf-qbft-net");
const detached = new Set<number>(),
  checks: string[] = [];
async function docker(...args: string[]) {
  const c = spawn("docker", args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "",
    error = "";
  c.stdout!.on("data", (b) => (log += b));
  c.stderr!.on("data", (b) => (error = (error + b).slice(-4000)));
  const code = await new Promise((r, j) => {
    c.once("error", j);
    c.once("exit", r);
  });
  assert.equal(code, 0, error || log);
  return log;
}
async function rpc(n: number, method: string, params: unknown[] = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const r = await fetch(`http://127.0.0.1:${8575 + n}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const j = await r.json();
    if (j.error) throw Error(j.error.message);
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}
async function reconnect(n: number) {
  if (!detached.has(n)) return;
  await docker(
    "network",
    "connect",
    "--ip",
    config.services[`validator${n + 1}`].networks.qbft.ipv4_address,
    network,
    `ccf-qbft-validator${n + 1}-1`,
  );
  detached.delete(n);
}
async function ready() {
  for (let i = 0; i < 150; i++) {
    try {
      await Promise.all([0, 1, 2, 3].map((n) => rpc(n, "eth_blockNumber")));
      return;
    } catch {}
    await delay(500);
  }
  throw Error("QBFT_READY_TIMEOUT");
}
async function growing(start: bigint) {
  for (let i = 0; i < 240; i++) {
    const h = BigInt(await rpc(0, "eth_blockNumber"));
    if (h >= start + 2n) return h;
    await delay(500);
  }
  throw Error("QBFT_QUORUM_DID_NOT_RECOVER");
}
try {
  // Restrict this fault injection to the generated local project and exact
  // validator containers. Other containers/networks are never selected.
  await docker("compose", "-f", file, "up", "-d");
  await ready();
  for (const n of [2, 3]) {
    const metadata = JSON.parse(
      await docker("inspect", `ccf-qbft-validator${n + 1}-1`),
    )[0];
    assert.equal(
      metadata.Config.Labels["com.docker.compose.project"],
      "ccf-qbft",
    );
    assert.equal(
      metadata.Config.Labels["com.docker.compose.service"],
      `validator${n + 1}`,
    );
  }
  await docker("network", "disconnect", network, "ccf-qbft-validator4-1");
  detached.add(3);
  await growing(BigInt(await rpc(0, "eth_blockNumber")));
  checks.push(
    "3+1 network separation: connected quorum continues finalizing new blocks",
  );
  await docker("network", "disconnect", network, "ccf-qbft-validator3-1");
  detached.add(2);
  await delay(5000);
  const frozen = BigInt(await rpc(0, "eth_blockNumber"));
  await delay(8000);
  assert.equal(BigInt(await rpc(0, "eth_blockNumber")), frozen);
  checks.push(
    "2+1+1 network separation: reachable minority stops finalization",
  );
  await reconnect(2);
  await reconnect(3);
  await ready();
  await growing(frozen);
  let agreed = false;
  for (let i = 0; i < 120; i++) {
    const heights = await Promise.all(
      [0, 1, 2, 3].map(async (n) => BigInt(await rpc(n, "eth_blockNumber"))),
    );
    const common = heights.reduce((a, b) => (a < b ? a : b)) - 1n;
    const blocks = await Promise.all(
      [0, 1, 2, 3].map((n) =>
        rpc(n, "eth_getBlockByNumber", [`0x${common.toString(16)}`, false]),
      ),
    );
    if (
      blocks.every((b) => b?.hash) &&
      new Set(blocks.map((b) => b.hash)).size === 1
    ) {
      agreed = true;
      break;
    }
    await delay(500);
  }
  assert(agreed);
  checks.push(
    "restored connectivity resumes finalization and all four validators agree on a common finalized block hash",
  );
  saveReport("qbft-partition", {
    date: new Date().toISOString(),
    passed: true,
    checks,
    scope:
      "Real Docker bridge disconnection on one host, 3+1 and 2+1+1 connectivity loss. Not malicious validator behavior, WAN packet scheduling, asymmetric partition or independent organizations.",
  });
  console.log(`${checks.length} QBFT network partition checks passed.`);
} finally {
  // Restore configured addresses before stopping this dedicated test network.
  for (const n of [...detached]) await reconnect(n);
  await docker("compose", "-f", file, "stop");
}
