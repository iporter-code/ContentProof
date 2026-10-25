import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { LocalHarness, saveReport } from "./local-harness.js";
import { hashBytes } from "../packages/protocol/index.js";
const legacy = process.env.CP_LEGACY_PROJECT_ROOT;
assert(
  legacy,
  "CP_LEGACY_PROJECT_ROOT must name a preserved Ganache 7.9.2 project snapshot",
);
assert.equal(
  JSON.parse(
    readFileSync(resolve(legacy, "node_modules/ganache/package.json"), "utf8"),
  ).version,
  "7.9.2",
);
const old = new LocalHarness("node-compat", 3098, 8598, legacy),
  next = new LocalHarness("node-compat-unused", 3098, 8598),
  checks: string[] = [];
next.env.DATA_DIR = old.dir;
let active: LocalHarness | undefined;
try {
  active = old;
  await old.start();
  const owner = await old.identity(),
    bytes = await sharp({
      create: { width: 48, height: 36, channels: 3, background: "#4b7962" },
    })
      .png()
      .toBuffer();
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)]),
    "historical-chain.png",
  );
  const asset = await old.call("/v1/assets", owner.token, form);
  const draft = await old.call("/v1/drafts/import", owner.token, {
      assetDigest: asset.digest,
      fields: { title: "节点升级前历史声明" },
    }),
    root = await old.sign(draft.id, owner);
  await old.confirmed(
    (await old.call(`/v1/claims/${root.id}/anchor`, owner.token, {})).jobId,
    owner.token,
  );
  const previous = await old.call(`/v1/claims/${root.id}`, owner.token),
    network = await old.call("/v1/chain/status"),
    height = Number(BigInt(await old.rpc("eth_blockNumber"))),
    blocks: string[] = [];
  for (let n = 0; n <= height; n++)
    blocks.push(
      (await old.rpc("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]))
        .hash,
    );
  const code = await old.rpc("eth_getCode", [network.provenance, "latest"]),
    keyHash = hashBytes(readFileSync(resolve(old.dir, "node.key")));
  await old.stop();
  active = undefined;
  checks.push(
    "Ganache 7.9.2 creates real signed claim, records every historical block hash and contract code",
  );
  active = next;
  await next.start();
  for (let n = 0; n <= height; n++)
    assert.equal(
      (await next.rpc("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]))
        .hash,
      blocks[n],
    );
  assert.equal(
    await next.rpc("eth_getCode", [network.provenance, "latest"]),
    code,
  );
  assert.equal(hashBytes(readFileSync(resolve(old.dir, "node.key"))), keyHash);
  assert.deepEqual(
    (await next.call(`/v1/claims/${root.id}`, owner.token)).manifest,
    previous.manifest,
  );
  assert.equal(
    (await next.call(`/v1/claims/${root.id}`, owner.token)).chain.anchor,
    "confirmed",
  );
  const content = await next.response(
    `/v1/assets/${asset.digest}/content`,
    owner.token,
  );
  assert(content.ok);
  assert.equal(
    hashBytes(new Uint8Array(await content.arrayBuffer())),
    asset.digest,
  );
  checks.push(
    "module node reopens existing chain without redeployment; all block hashes, code, fee key, signatures and original bytes preserved",
  );
  const edited = await next.call("/v1/drafts/transform", owner.token, {
      parents: [root.id],
      operation: "crop",
      params: { left: 1, top: 1, width: 24, height: 18 },
      fields: { title: "节点升级后派生声明" },
    }),
    derived = await next.sign(edited.id, owner);
  await next.confirmed(
    (await next.call(`/v1/claims/${derived.id}/anchor`, owner.token, {})).jobId,
    owner.token,
  );
  const zip = await next.response("/v1/bundles", owner.token, {
    target: derived.id,
    hideFields: [],
    hideParents: [],
  });
  assert(zip.ok);
  const v = new FormData();
  v.append("file", new Blob([await zip.arrayBuffer()]), "evidence.zip");
  const report = await next.call("/v1/verify", owner.token, v);
  assert.equal(report.outcome, "pass");
  assert.equal(report.checks.transformation, "reproduced");
  checks.push(
    "new edits and writes on old chain export and independently reproduce",
  );
  const head = await next.rpc("eth_blockNumber"),
    headHash = (await next.rpc("eth_getBlockByNumber", [head, false])).hash;
  await next.stop();
  active = undefined;
  active = next;
  await next.start();
  assert.equal(
    (await next.rpc("eth_getBlockByNumber", [head, false])).hash,
    headHash,
  );
  assert.equal(
    (await next.call(`/v1/claims/${derived.id}`, owner.token)).chain.anchor,
    "confirmed",
  );
  await next.stop();
  active = undefined;
  checks.push(
    "module node full restart preserves historical and newly written claims",
  );
  active = old;
  await old.start();
  assert.equal(
    (await old.rpc("eth_getBlockByNumber", [head, false])).hash,
    headHash,
  );
  assert.equal(
    (await old.call(`/v1/claims/${derived.id}`, owner.token)).chain.anchor,
    "confirmed",
  );
  checks.push(
    "original bundled node can reopen the database after new writes, validating rollback compatibility",
  );
  console.log(
    `${checks.length} real old/new node compatibility groups passed.`,
  );
} finally {
  await active?.stop();
  saveReport("node-upgrade-compatibility", {
    date: new Date().toISOString(),
    passed: checks.length === 5,
    checks,
    scope:
      "Synthetic persistent database created by preserved actual Ganache 7.9.2, then module node, restart and rollback. No production database or private material copied.",
  });
}
