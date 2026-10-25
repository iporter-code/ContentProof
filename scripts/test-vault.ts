import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import sharp from "sharp";
import { generatePrivateKey } from "viem/accounts";
import { LocalHarness, delay, saveReport } from "./local-harness.js";
import { loadConfiguredSecrets } from "../packages/config/secrets.js";
import {
  prepareVaultRotation,
  recoverVaultRotation,
} from "../packages/persistence/vault-rotation.js";
import { restoreData } from "../packages/persistence/maintenance.js";

const binary = resolve(
  process.env.CP_VAULT_BINARY ?? "data/tools/vault-2.2.1/binary/vault.exe",
);
assert(
  existsSync(binary),
  "CP_VAULT_BINARY_REQUIRED: use a checksum-verified official Vault binary",
);
const version = spawnSync(binary, ["version"], {
  encoding: "utf8",
  windowsHide: true,
});
assert.equal(version.status, 0);
const vaultURL = "http://127.0.0.1:8310";
try {
  await fetch(vaultURL, { signal: AbortSignal.timeout(500) });
  throw Error("VAULT_TEST_PORT_OCCUPIED");
} catch (error) {
  if ((error as Error).message === "VAULT_TEST_PORT_OCCUPIED") throw error;
}
const h = new LocalHarness("vault", 3090, 8590),
  t = new LocalHarness("vault-transit", 3092, 8592),
  checks: string[] = [];
const rootToken = randomBytes(32).toString("hex"),
  storageKey = randomBytes(32).toString("hex"),
  relayerKey = generatePrivateKey();
const tokenFile = h.dir + "-vault-token",
  password = randomBytes(24).toString("hex");
writeFileSync(resolve(h.dir, "node.key"), relayerKey, {
  mode: 0o600,
  flag: "wx",
});
let vault: ChildProcess | undefined;
async function request(
  path: string,
  body?: unknown,
  token = rootToken,
  expectStatus = 200,
) {
  const response = await fetch(vaultURL + "/v1/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, expectStatus, "VAULT_TEST_HTTP_STATUS");
  return response.status === 204 ? null : response.json();
}
async function stopVault() {
  if (!vault || vault.exitCode !== null || vault.signalCode !== null) return;
  const exited = new Promise<void>((done) => vault!.once("exit", () => done()));
  vault.kill();
  await exited;
}
async function maintenance(args: string[], targetEnv = h.env) {
  const child = spawn(
    process.execPath,
    ["dist/server/scripts/maintenance.js", ...args],
    {
      env: { ...targetEnv, CP_BACKUP_PASSWORD: password },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "",
    error = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (error += b));
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  assert.equal(code, 0, error);
  return JSON.parse(out.trim());
}
try {
  // In-memory dev Vault, bound only to loopback. Never a production deployment.
  // Its output contains generated credentials and is discarded rather than logged.
  vault = spawn(
    binary,
    ["server", "-dev", "-dev-listen-address=127.0.0.1:8310"],
    {
      env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: rootToken },
      windowsHide: true,
      stdio: "ignore",
    },
  );
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (vault.exitCode !== null) throw Error("VAULT_TEST_EXITED");
    try {
      if (
        (
          await fetch(vaultURL + "/v1/sys/health", {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert(ready, "VAULT_TEST_START_TIMEOUT");
  await request("secret/data/contentproof/storage", {
    options: { cas: 0 },
    data: { key: storageKey },
  });
  await request("secret/data/contentproof/relayer", {
    options: { cas: 0 },
    data: { key: relayerKey },
  });
  await request(
    "sys/policies/acl/contentproof-test-read",
    {
      policy:
        'path "secret/data/contentproof/storage" { capabilities = ["read"] }\npath "secret/data/contentproof/relayer" { capabilities = ["read"] }',
    },
    rootToken,
    204,
  );
  const created = await request("auth/token/create", {
    policies: ["contentproof-test-read"],
    no_default_policy: true,
    ttl: "10m",
  });
  const readToken = created.auth.client_token;
  writeFileSync(tokenFile, readToken, { flag: "wx", mode: 0o600 });
  Object.assign(h.env, {
    VAULT_ADDR: vaultURL,
    VAULT_TOKEN_FILE: tokenFile,
    STORAGE_KEY_VAULT_PATH: "contentproof/storage",
    STORAGE_KEY_VAULT_VERSION: "1",
    RELAYER_PRIVATE_KEY_VAULT_PATH: "contentproof/relayer",
    RELAYER_PRIVATE_KEY_VAULT_VERSION: "1",
  });
  await request(
    "secret/data/contentproof/storage",
    { data: { key: storageKey } },
    readToken,
    403,
  );
  const resolved = { ...h.env };
  await loadConfiguredSecrets(resolved);
  assert.equal(resolved.STORAGE_KEY, storageKey);
  assert.equal(resolved.RELAYER_PRIVATE_KEY, relayerKey);
  checks.push(
    "real Vault KV v2 loads both exact-version keys; application token cannot write secrets",
  );
  await h.start();
  assert(
    !existsSync(resolve(h.dir, "storage.key")),
    "REMOTE_KEY_MUST_NOT_BE_WRITTEN_LOCALLY",
  );
  const user = await h.identity();
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#54778a" },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(png)]), "synthetic-vault.png");
  const asset = await h.call("/v1/assets", user.token, form);
  const draft = await h.call("/v1/drafts/import", user.token, {
    assetDigest: asset.digest,
    fields: { title: "真实本机Vault验收" },
  });
  const signed = await h.sign(draft.id, user),
    job = await h.call(`/v1/claims/${signed.id}/anchor`, user.token, {});
  await h.confirmed(job.jobId, user.token);
  const original = await h.call(`/v1/claims/${signed.id}`, user.token);
  assert.equal(original.chain.anchor, "confirmed");
  checks.push(
    "non-demo service uploads, encrypts, signs and anchors using keys read from real Vault",
  );
  await h.stop();
  // An administrator creates v2, but the application remains explicitly on v1.
  // This is version pinning, not a claim of data-key re-encryption/rotation.
  await request("secret/data/contentproof/storage", {
    options: { cas: 1 },
    data: { key: randomBytes(32).toString("hex") },
  });
  await h.start();
  user.token = await user.login();
  assert.equal(
    (await h.call(`/v1/claims/${signed.id}`, user.token)).chain.anchor,
    "confirmed",
  );
  const assetBytes = await h.response(
    `/v1/assets/${asset.digest}/content`,
    user.token,
  );
  assert(assetBytes.ok);
  assert.deepEqual(Buffer.from(await assetBytes.arrayBuffer()), png);
  checks.push(
    "full service restart reads pinned v1 and original bytes after Vault publishes v2",
  );
  await h.stop();
  const referenceFile = h.dir + "-storage.ref.json";
  writeFileSync(
    referenceFile,
    JSON.stringify({ version: 1, path: "contentproof/storage", keyVersion: 1 }),
    { flag: "wx", mode: 0o600 },
  );
  delete h.env.STORAGE_KEY_VAULT_PATH;
  delete h.env.STORAGE_KEY_VAULT_VERSION;
  h.env.STORAGE_KEY_VAULT_REF_FILE = referenceFile;
  await prepareVaultRotation(h.dir, 2, h.env);
  await assert.rejects(() => h.start(), /KEY_ROTATION_RECOVERY_REQUIRED/);
  await recoverVaultRotation(h.dir, "commit", h.env);
  assert.equal(JSON.parse(readFileSync(referenceFile, "utf8")).keyVersion, 2);
  await h.start();
  user.token = await user.login();
  assert.equal(
    (await h.call(`/v1/claims/${signed.id}`, user.token)).chain.anchor,
    "confirmed",
  );
  const rotated = await h.response(
    `/v1/assets/${asset.digest}/content`,
    user.token,
  );
  assert(rotated.ok);
  assert.deepEqual(Buffer.from(await rotated.arrayBuffer()), png);
  assert(!existsSync(resolve(h.dir, "storage.key")));
  checks.push(
    "real KV v1-to-v2 offline re-encryption preserves records/images and publishes only a version reference",
  );
  await h.stop();
  await request("secret/data/contentproof/storage", {
    options: { cas: 2 },
    data: { key: randomBytes(32).toString("hex") },
  });
  assert.equal((await maintenance(["prepare-vault", "3"])).pending, true);
  await assert.rejects(() => h.start(), /KEY_ROTATION_RECOVERY_REQUIRED/);
  checks.push(
    "compiled maintenance prepares the next version and pending recovery blocks application startup",
  );
  const journal = JSON.parse(
    readFileSync(`${h.dir}.key-rotation.json`, "utf8"),
  );
  assert.equal(journal.source, h.dir);
  assert.match(journal.tag, /^[a-f0-9]{16}$/);
  const rollback = `${h.dir}.rollback-vault-${journal.tag}`,
    stage = `${h.dir}.rotate-vault-${journal.tag}`;
  const runRoot = dirname(h.dir) + sep;
  for (const path of [h.dir, rollback, stage])
    assert(resolve(path).startsWith(runRoot));
  // Inject a durable interrupted-publish boundary while all service processes
  // are stopped. This is not an arbitrary-timing host power-loss test.
  renameSync(h.dir, rollback);
  renameSync(stage, h.dir);
  await request(
    "secret/destroy/contentproof/storage",
    { versions: [3] },
    rootToken,
    204,
  );
  assert.equal(
    (await maintenance(["recover-vault", "rollback"])).activeVersion,
    2,
  );
  await h.start();
  user.token = await user.login();
  const reverted = await h.response(
    `/v1/assets/${asset.digest}/content`,
    user.token,
  );
  assert(reverted.ok);
  assert.deepEqual(Buffer.from(await reverted.arrayBuffer()), png);
  checks.push(
    "injected interrupted data publication rolls back even after the unused next Vault version is destroyed",
  );
  await h.stop();
  const backup = h.dir + "-backup",
    restored = h.dir + "-restored";
  // The test-only token is outside the source data and its backup.
  const active = { ...h.env };
  await loadConfiguredSecrets(active);
  const activeKey = Buffer.from(active.STORAGE_KEY!, "hex");
  await maintenance(["backup", backup]);
  await restoreData(backup, restored, password);
  assert.deepEqual(readFileSync(resolve(restored, "storage.key")), activeKey);
  const source = h.env.DATA_DIR;
  h.env.DATA_DIR = restored;
  await h.start();
  user.token = await user.login();
  assert.equal(
    (await h.call(`/v1/claims/${signed.id}`, user.token)).chain.anchor,
    "confirmed",
  );
  const restoredBytes = await h.response(
    `/v1/assets/${asset.digest}/content`,
    user.token,
  );
  assert(restoredBytes.ok);
  assert.deepEqual(Buffer.from(await restoredBytes.arrayBuffer()), png);
  checks.push(
    "encrypted backup/new-directory recovery preserves the Vault-backed image and chain record",
  );
  await h.stop();
  h.env.DATA_DIR = source;
  await request("sys/mounts/transit", { type: "transit" }, rootToken, 204);
  await request(
    "transit/keys/contentproof-test",
    { type: "aes256-gcm96", exportable: false, allow_plaintext_backup: false },
    rootToken,
    200,
  );
  await request(
    "sys/policies/acl/contentproof-transit-test",
    {
      policy:
        'path "transit/decrypt/contentproof-test" { capabilities = ["update"] }\npath "transit/rewrap/contentproof-test" { capabilities = ["update"] }',
    },
    rootToken,
    204,
  );
  const transitToken = (
    await request("auth/token/create", {
      policies: ["contentproof-transit-test"],
      no_default_policy: true,
      ttl: "10m",
    })
  ).auth.client_token;
  const transitTokenFile = t.dir + "-token",
    provisionTokenFile = t.dir + "-provision-token",
    envelopeFile = t.dir + "-key.envelope.json";
  writeFileSync(transitTokenFile, transitToken, { flag: "wx", mode: 0o600 });
  writeFileSync(provisionTokenFile, rootToken, { flag: "wx", mode: 0o600 });
  const transitEnvironment = {
    ...t.env,
    VAULT_ADDR: vaultURL,
    VAULT_TOKEN_FILE: provisionTokenFile,
    VAULT_TRANSIT_KEY: "contentproof-test",
  };
  assert.equal(
    (await maintenance(["init-transit", envelopeFile], transitEnvironment))
      .created,
    true,
  );
  Object.assign(t.env, {
    VAULT_ADDR: vaultURL,
    VAULT_TOKEN_FILE: transitTokenFile,
    STORAGE_KEY_VAULT_TRANSIT_FILE: envelopeFile,
  });
  await request("transit/keys/contentproof-test/rotate", {}, transitToken, 403);
  await request(
    "transit/datakey/wrapped/contentproof-test",
    { bits: 256 },
    transitToken,
    403,
  );
  checks.push(
    "compiled provisioning writes only a wrapped data key; application token cannot create keys or rotate Vault KEKs",
  );
  await t.start();
  const transitUser = await t.identity();
  const tf = new FormData();
  tf.append("file", new Blob([new Uint8Array(png)]), "synthetic-transit.png");
  const ta = await t.call("/v1/assets", transitUser.token, tf),
    td = await t.call("/v1/drafts/import", transitUser.token, {
      assetDigest: ta.digest,
      fields: { title: "Transit信封加密真实验收" },
    });
  const ts = await t.sign(td.id, transitUser);
  await t.confirmed(
    (await t.call(`/v1/claims/${ts.id}/anchor`, transitUser.token, {})).jobId,
    transitUser.token,
  );
  assert(!existsSync(resolve(t.dir, "storage.key")));
  const objectFile = resolve(t.dir, "objects", ta.digest.slice(2)),
    sealedBefore = readFileSync(objectFile);
  checks.push(
    "a fresh Transit-backed service uploads, encrypts, signs and anchors without a plaintext storage.key file",
  );
  await t.stop();
  await request("transit/keys/contentproof-test/rotate", {}, rootToken, 200);
  const rewrapped = await maintenance(["rewrap-transit"], t.env);
  assert.equal(rewrapped.fromVersion, 1);
  assert.equal(rewrapped.toVersion, 2);
  assert.deepEqual(readFileSync(objectFile), sealedBefore);
  await t.start();
  transitUser.token = await transitUser.login();
  const afterRewrap = await t.response(
    `/v1/assets/${ta.digest}/content`,
    transitUser.token,
  );
  assert(afterRewrap.ok);
  assert.deepEqual(Buffer.from(await afterRewrap.arrayBuffer()), png);
  assert.equal(
    (await t.call(`/v1/claims/${ts.id}`, transitUser.token)).chain.anchor,
    "confirmed",
  );
  checks.push(
    "actual Vault KEK rotation and compiled rewrap preserve the data key, encrypted object bytes and original on-chain record",
  );
  await t.stop();
  const bad = JSON.parse(readFileSync(envelopeFile, "utf8"));
  bad.ciphertext = bad.ciphertext.slice(0, -4) + "AAAA";
  const tampered = t.dir + "-tampered-envelope.json";
  writeFileSync(tampered, JSON.stringify(bad));
  await assert.rejects(
    () =>
      loadConfiguredSecrets({
        ...t.env,
        STORAGE_KEY_VAULT_TRANSIT_FILE: tampered,
      }),
    /VAULT_HTTP_400/,
  );
  checks.push(
    "tampered wrapped-key ciphertext is rejected without generating a replacement key",
  );
  await stopVault();
  await assert.rejects(
    () => loadConfiguredSecrets({ ...h.env }),
    /VAULT_REQUEST_FAILED/,
  );
  await assert.rejects(
    () => loadConfiguredSecrets({ ...t.env }),
    /VAULT_REQUEST_FAILED/,
  );
  checks.push(
    "unavailable Vault fails closed with no generated substitute key",
  );
  saveReport("vault-local", {
    date: new Date().toISOString(),
    passed: true,
    version: version.stdout.trim(),
    checks,
    scope:
      "Actual checksum-verified Vault on loopback: KV v2 pins and local data re-encryption/recovery, Transit wrapped data keys and KEK rewrap, scoped application tokens, compiled maintenance and encrypted backup/restore. Not production Vault HA/TLS, cloud KMS, arbitrary crash timing, HSM or cross-host coordination.",
  });
  console.log(`${checks.length} real local Vault checks passed.`);
} finally {
  await h.stop();
  await t.stop();
  await stopVault();
}
