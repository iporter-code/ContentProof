import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import sharp from "sharp";
import {
  c2paSettings,
  c2paAvailability,
  verifyC2pa,
  C2PA_MAX_BYTES,
} from "../packages/c2pa/index.js";
import { LocalHarness, saveReport } from "./local-harness.js";
import { C2PA_VERSION, C2PA_VERIFIER } from "../packages/c2pa/version.js";

const h = new LocalHarness("c2pa", 3094, 8594),
  checks: string[] = [];
mkdirSync("data/c2pa-tests", { recursive: true });
const dir = mkdtempSync(resolve("data/c2pa-tests/run-"));
assert(c2paAvailability().available, "RUN_SETUP_C2PA_FIRST");
const install = resolve(
    process.env.CP_C2PA_INSTALL_DIR ??
      `data/tools/c2patool-${C2PA_VERSION}/${process.platform}-${process.arch}`,
  ),
  receipt = JSON.parse(readFileSync(join(install, "provenance.json"), "utf8"));
const executable = resolve(install, receipt.binary),
  settings = join(dir, "settings.json"),
  manifest = join(dir, "manifest.json"),
  anchors = join(dir, "synthetic-anchors.pem");
const previousTrust = process.env.CP_C2PA_TRUST_ANCHORS_FILE,
  previousSettings = process.env.C2PATOOL_SETTINGS;
writeFileSync(settings, JSON.stringify(c2paSettings()));
writeFileSync(
  manifest,
  JSON.stringify({
    claim_generator_info: [
      { name: "ContentProof isolated native C2PA test", version: "1.0" },
    ],
    title: "Synthetic credential test; not an institutional identity",
    assertions: [
      {
        label: "c2pa.actions",
        data: {
          actions: [
            {
              action: "c2pa.created",
              digitalSourceType:
                "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
            },
          ],
        },
      },
    ],
  }),
);
function command(args: string[], expected = 0) {
  const r = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(r.status, expected, r.stderr);
  if (expected === 1)
    assert.match(r.stderr, /must fetch remote manifests from url/);
  return r.stdout;
}
function sign(
  input: string,
  output: string,
  extra: string[] = [],
  expected = 0,
) {
  command(
    [input, "--settings", settings, "-m", manifest, "-o", output, ...extra],
    expected,
  );
  return readFileSync(output);
}
function form(bytes: Uint8Array, name = "asset.png") {
  const f = new FormData();
  f.append("file", new Blob([new Uint8Array(bytes)]), name);
  return f;
}
function wav() {
  const b = Buffer.alloc(44 + 16000);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(16000, 40);
  for (let i = 44; i < b.length; i += 2)
    b.writeInt16LE(Math.round(Math.sin(i / 13) * 8000), i);
  return b;
}
function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function tamperPng(original: Buffer) {
  const b = Buffer.from(original);
  for (let i = 8; i < b.length;) {
    const size = b.readUInt32BE(i),
      kind = b.toString("ascii", i + 4, i + 8);
    if (kind === "IDAT") {
      b[i + 8 + Math.min(5, size - 1)] ^= 1;
      b.writeUInt32BE(crc32(b.subarray(i + 4, i + 8 + size)), i + 8 + size);
      return b;
    }
    i += size + 12;
  }
  throw Error("TEST_IDAT_MISSING");
}
let remoteRequests = 0;
const remote = createServer((_req, res) => {
  remoteRequests++;
  res.writeHead(404);
  res.end();
});
try {
  delete process.env.CP_C2PA_TRUST_ANCHORS_FILE;
  const png = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "#72aa44" },
  })
    .png()
    .toBuffer();
  const source = join(dir, "source.png"),
    signedPath = join(dir, "signed.png");
  writeFileSync(source, png);
  const signed = sign(source, signedPath);
  assert.deepEqual((await verifyC2pa(png)).findings, [
    { code: "C2PA_EMBEDDED_MANIFEST_UNAVAILABLE", severity: "informational" },
  ]);
  checks.push("unsigned image is incomplete, never valid or trusted");
  const untrusted = await verifyC2pa(signed);
  assert.equal(untrusted.integrity, "valid");
  assert.equal(untrusted.trust, "not-configured");
  assert.equal(untrusted.outcome, "incomplete");
  checks.push(
    "native signature and data binding verified while signer remains untrusted",
  );
  const certs = command([signedPath, "--settings", settings, "--certs"]).match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  )!;
  writeFileSync(
    anchors,
    certs.filter((c) => new X509Certificate(c).ca).join("\n"),
  );
  process.env.CP_C2PA_TRUST_ANCHORS_FILE = anchors;
  const trusted = await verifyC2pa(signed);
  assert.equal(trusted.outcome, "pass");
  assert.equal(trusted.trust, "operator-trusted");
  assert.equal(trusted.revocation, "online-not-checked");
  checks.push("explicit synthetic CA policy passes only within offline scope");
  const tampered = await verifyC2pa(tamperPng(signed));
  assert.equal(tampered.outcome, "fail");
  assert(
    tampered.findings.some((x) => x.code === "assertion.dataHash.mismatch"),
  );
  checks.push(
    "changed image payload with valid PNG CRC fails native hard binding",
  );
  const leaf = join(dir, "leaf.pem");
  writeFileSync(
    leaf,
    certs.find((c) => !new X509Certificate(c).ca)!,
  );
  process.env.CP_C2PA_TRUST_ANCHORS_FILE = leaf;
  await assert.rejects(verifyC2pa(signed), /REQUIRES_CA_CERTIFICATES/);
  checks.push("leaf certificate cannot silently become an operator CA anchor");
  process.env.CP_C2PA_TRUST_ANCHORS_FILE = anchors;
  const fixtures = [
    {
      ext: "jpg",
      bytes: await sharp(png).jpeg().toBuffer(),
      type: "image/jpeg",
    },
    { ext: "wav", bytes: wav(), type: "audio/wav" },
    {
      ext: "mp4",
      bytes: readFileSync(
        process.env.CP_C2PA_VIDEO_FIXTURE ??
          "data/tools/c2pa-fixtures/video.mp4",
      ),
      type: "video/mp4",
    },
  ];
  const vectors: any[] = [];
  for (const f of fixtures) {
    const input = join(dir, "source." + f.ext),
      output = join(dir, "signed." + f.ext);
    writeFileSync(input, f.bytes);
    const bytes = sign(input, output),
      report = await verifyC2pa(bytes);
    assert.equal(report.outcome, "pass");
    assert.equal(report.mediaType, f.type);
    vectors.push({
      format: f.type,
      inputSha256: createHash("sha256").update(f.bytes).digest("hex"),
      signedSha256: report.sha256,
    });
    if (f.ext === "wav" || f.ext === "mp4") {
      const b = Buffer.from(bytes),
        tag = Buffer.from(f.ext === "wav" ? "data" : "mdat"),
        at = b.indexOf(tag);
      assert(at >= 0);
      b[at + Math.min(f.ext === "wav" ? 12 : 80, b.length - at - 1)] ^= 1;
      assert.equal((await verifyC2pa(b)).outcome, "fail");
    }
    checks.push(
      `${f.type} real native credential and file binding${f.ext === "jpg" ? "" : " plus payload tampering"}`,
    );
  }
  await new Promise<void>((r) => remote.listen(0, "127.0.0.1", r));
  const port = (remote.address() as { port: number }).port;
  const remotePath = join(dir, "remote.png"),
    remoteAsset = sign(
      source,
      remotePath,
      [
        "--sidecar",
        "--remote",
        `http://127.0.0.1:${port}/private-resource.c2pa`,
        "--no_signing_verify",
      ],
      1,
    ),
    before = remoteRequests;
  const remoteReport = await verifyC2pa(remoteAsset);
  assert.equal(remoteReport.outcome, "incomplete");
  assert.equal(remoteRequests, before);
  checks.push("remote manifest URL cannot trigger a request to a local server");
  process.env.C2PATOOL_SETTINGS = join(
    dir,
    "nonexistent-malicious-settings.json",
  );
  assert.equal((await verifyC2pa(signed)).outcome, "pass");
  checks.push(
    "caller native-tool settings cannot override private verifier settings",
  );
  await assert.rejects(
    verifyC2pa(Buffer.from("untrusted executable")),
    /MEDIA_UNSUPPORTED/,
  );
  await assert.rejects(
    verifyC2pa(Buffer.alloc(C2PA_MAX_BYTES + 1)),
    /SIZE_LIMIT/,
  );
  checks.push(
    "unsupported and oversized assets rejected before native execution",
  );
  h.env.CP_C2PA_TRUST_ANCHORS_FILE = anchors;
  await h.start();
  const user = await h.identity();
  assert.equal(
    (await h.response("/v1/verify/c2pa", "", form(signed))).status,
    401,
  );
  checks.push("API requires authenticated identity");
  assert((await h.call("/v1/verify/c2pa/status", user.token)).available);
  const apiReport = await h.call(
    "/v1/verify/c2pa",
    user.token,
    form(signed, "ignored-client-name.exe"),
  );
  assert.equal(apiReport.outcome, "pass");
  assert.equal(apiReport.sha256, trusted.sha256);
  checks.push(
    "built authenticated API validates actual bytes independently of upload filename",
  );
  assert.equal(
    (
      await h.response(
        "/v1/verify/c2pa",
        user.token,
        form(Buffer.alloc(C2PA_MAX_BYTES + 1)),
      )
    ).status,
    413,
  );
  checks.push("API rejects files over the native 20MiB boundary");
  const status = await h.call("/v1/system/metrics", user.token);
  assert.equal(status.resources.verify, 0);
  await h.stop();
  const cli = spawnSync(
    process.execPath,
    ["dist/server/apps/verifier/main.js", "verify-c2pa", signedPath],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).sha256, trusted.sha256);
  checks.push(
    "compiled independent CLI validates same asset without business API",
  );
  saveReport(
    process.platform === "win32" ? "c2pa-native" : "c2pa-native-linux",
    {
      date: new Date().toISOString(),
      passed: true,
      verifier: C2PA_VERIFIER,
      platform: process.platform,
      checks,
      vectors,
      scope:
        "Official pinned binary; synthetic test certificates; local operator trust only; no production identity, online revocation, CAWG identity, remote-manifest fetch, native signing service or C2PA conformance claim.",
    },
  );
  console.log(`Native C2PA: ${checks.length} checks passed.`);
} finally {
  await h.stop();
  remote.close();
  if (previousTrust === undefined)
    delete process.env.CP_C2PA_TRUST_ANCHORS_FILE;
  else process.env.CP_C2PA_TRUST_ANCHORS_FILE = previousTrust;
  if (previousSettings === undefined) delete process.env.C2PATOOL_SETTINGS;
  else process.env.C2PATOOL_SETTINGS = previousSettings;
}
