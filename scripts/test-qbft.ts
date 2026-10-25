import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
const config = resolve("data/qbft-network/compose.json"),
  rows: string[] = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(node: number, method: string, params: unknown[] = []) {
  const r = await fetch(`http://127.0.0.1:${8575 + node}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(2000),
  });
  const body = await r.json();
  if (body.error) throw Error(String(body.error.message));
  return body.result;
}
async function compose(...args: string[]) {
  const c = spawn("docker", ["compose", "-f", config, ...args], {
    windowsHide: true,
    stdio: "ignore",
  });
  const code = await new Promise((r) => c.once("exit", r));
  assert.equal(code, 0, "QBFT compose command failed");
}
async function ready() {
  for (let i = 0; i < 90; i++) {
    try {
      const heights = await Promise.all(
        [0, 1, 2, 3].map(async (n) => BigInt(await rpc(n, "eth_blockNumber"))),
      );
      if (heights.every((h) => h >= 2n)) return heights;
    } catch {}
    await delay(500);
  }
  throw Error("QBFT_NETWORK_NOT_READY");
}
async function growing(start: bigint, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const h = BigInt(await rpc(0, "eth_blockNumber"));
    if (h >= start + 2n) return h;
    await delay(500);
  }
  throw Error("QBFT_CHAIN_STOPPED");
}
try {
  const heights = await ready(),
    common = heights.reduce((a, b) => (a < b ? a : b)) - 1n,
    hex = `0x${common.toString(16)}`,
    blocks = await Promise.all(
      [0, 1, 2, 3].map((n) => rpc(n, "eth_getBlockByNumber", [hex, false])),
    );
  assert.equal(new Set(blocks.map((b) => b.hash)).size, 1);
  assert.equal(
    (await rpc(0, "qbft_getValidatorsByBlockNumber", ["latest"])).length,
    4,
  );
  rows.push(
    "four independent validator processes agree on finalized block hash",
  );
  const outsider = privateKeyToAccount(generatePrivateKey()),
    raw = await outsider.signTransaction({
      chainId: 31338,
      nonce: 0,
      gas: 21000n,
      gasPrice: 0n,
      to: outsider.address,
      value: 0n,
    });
  await assert.rejects(
    rpc(0, "eth_sendRawTransaction", [raw]),
    /allow|permission|author/i,
  );
  rows.push("account permissioning rejects an unapproved sender");
  await compose("stop", "validator4");
  const before = BigInt(await rpc(0, "eth_blockNumber"));
  await growing(before);
  rows.push(
    "three of four validators finalize at least two new blocks after one node is fully stopped",
  );
  await compose("stop", "validator3");
  await delay(4000);
  const stopped = BigInt(await rpc(0, "eth_blockNumber"));
  await delay(7000);
  assert.equal(BigInt(await rpc(0, "eth_blockNumber")), stopped);
  rows.push(
    "two of four validators stop finalization rather than claim success",
  );
  const recoveryStart = Date.now();
  await compose("start", "validator3", "validator4");
  await ready();
  await growing(stopped, 120000);
  rows.push(
    `quorum restoration resumes finalization after ${Date.now() - recoveryStart} ms including container restart and QBFT round backoff`,
  );
  mkdirSync("data/app/results", { recursive: true });
  writeFileSync(
    "data/app/results/qbft.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        besu: "26.10.0",
        chainId: 31338,
        passed: true,
        scope:
          "Four Docker validators on one Windows/WSL host. This is not independent cross-organization infrastructure or full Byzantine adversarial testing.",
        checks: rows,
      },
      null,
      2,
    ),
  );
  console.log(`${rows.length} real QBFT checks passed.`);
} finally {
  await compose("start", "validator3", "validator4");
}
