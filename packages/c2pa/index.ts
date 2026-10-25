import { createHash, X509Certificate } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { ResourcePool } from "../media/resources.js";
import { normalizeC2pa, type C2paReport } from "./report.js";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const pool = new ResourcePool(1, 2);
export const C2PA_MAX_BYTES = 20 * 1024 * 1024;
export function c2paMedia(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { extension: "png", mediaType: "image/png" as const };
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return { extension: "jpg", mediaType: "image/jpeg" as const };
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WAVE"
  )
    return { extension: "wav", mediaType: "audio/wav" as const };
  if (
    b.toString("ascii", 4, 8) === "ftyp" &&
    b.length >= 16 &&
    /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(b.toString("ascii", 8, 12))
  )
    return { extension: "mp4", mediaType: "video/mp4" as const };
  throw Error("C2PA_MEDIA_UNSUPPORTED");
}
function binary() {
  const config = JSON.parse(
    readFileSync(resolve("configs/native-tools.json"), "utf8"),
  ).c2patool;
  const target = `${process.platform}-${process.arch}`,
    pin = config[target];
  if (!pin) throw Error("C2PA_BINARY_PLATFORM_UNSUPPORTED");
  const dir = resolve(
    process.env.CP_C2PA_INSTALL_DIR ??
      `data/tools/c2patool-${config.version}/${target}`,
  );
  const receiptFile = join(dir, "provenance.json");
  if (!existsSync(receiptFile)) throw Error("C2PA_BINARY_NOT_INSTALLED");
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  const path = realpathSync(resolve(dir, receipt.binary));
  if (
    !path.startsWith(realpathSync(dir) + sep) ||
    receipt.version !== config.version ||
    receipt.archiveSha256 !== pin.sha256 ||
    receipt.source !== pin.url ||
    !pin.binarySha256 ||
    sha(readFileSync(path)) !== pin.binarySha256
  )
    throw Error("C2PA_BINARY_INTEGRITY_FAILED");
  const probe = spawnSync(path, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2000,
    maxBuffer: 16384,
    cwd: dir,
    env: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH:
        process.platform === "win32"
          ? `${process.env.SystemRoot}\\System32`
          : "/usr/bin:/bin",
    },
  });
  if (
    probe.status !== 0 ||
    probe.stdout.trim() !== `c2patool ${config.version}`
  )
    throw Error("C2PA_RUNTIME_INCOMPATIBLE");
  return path;
}
export function c2paAvailability() {
  try {
    binary();
    trustPolicy();
    return { available: true, version: "0.28.2", reason: null };
  } catch (e) {
    const message = (e as Error).message;
    return {
      available: false,
      version: "0.28.2",
      reason: /^C2PA_[A-Z_]+$/.test(message)
        ? message
        : "C2PA_CONFIGURATION_INVALID",
    };
  }
}
export function c2paSettings(anchors = "") {
  return {
    core: {
      decode_identity_assertions: false,
      allowed_network_hosts: [],
      allow_redirects: false,
      max_decompressed_manifest_size_in_mb: 8,
    },
    verify: {
      verify_after_reading: true,
      verify_trust: true,
      verify_timestamp_trust: true,
      remote_manifest_fetch: false,
      ocsp_fetch: false,
    },
    trust: {
      anchors: anchors
        ? [{ trust_anchors: anchors, trust_kind: "manifest" }]
        : [],
    },
  };
}
function trustPolicy() {
  const path = process.env.CP_C2PA_TRUST_ANCHORS_FILE;
  if (!path) return { anchors: "", policySha256: null };
  if (statSync(path).size > 1024 * 1024) throw Error("C2PA_TRUST_POLICY_LIMIT");
  const bytes = readFileSync(path),
    anchors = bytes.toString("utf8");
  const certs = anchors.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (
    !certs?.length ||
    anchors
      .replace(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
        "",
      )
      .trim()
  )
    throw Error("C2PA_TRUST_POLICY_INVALID");
  try {
    if (certs.some((c) => !new X509Certificate(c).ca)) throw Error();
  } catch {
    throw Error("C2PA_TRUST_POLICY_REQUIRES_CA_CERTIFICATES");
  }
  return { anchors, policySha256: sha(bytes) };
}
async function invoke(executable: string, dir: string, extension: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, reject) => {
      const child = spawn(
        executable,
        [
          join(dir, `asset.${extension}`),
          "--settings",
          join(dir, "settings.json"),
        ],
        {
          cwd: dir,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            PATH:
              process.platform === "win32"
                ? `${process.env.SystemRoot}\\System32`
                : "/usr/bin:/bin",
            HOME: dir,
            USERPROFILE: dir,
            APPDATA: dir,
            LOCALAPPDATA: dir,
            TMP: dir,
            TEMP: dir,
            TMPDIR: dir,
          },
        },
      );
      let stdout = "",
        stderr = "",
        size = 0,
        failure: Error | undefined;
      const stop = (code: string) => {
        failure ??= Error(code);
        child.kill();
      };
      const timer = setTimeout(() => stop("C2PA_VERIFIER_TIMEOUT"), 20000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(Error("C2PA_VERIFIER_START_FAILED"));
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (b) => {
        size += Buffer.byteLength(b);
        if (size > 4 * 1024 * 1024) stop("C2PA_REPORT_LIMIT");
        else stdout += b;
      });
      child.stderr.on("data", (b) => {
        size += Buffer.byteLength(b);
        if (size > 4 * 1024 * 1024) stop("C2PA_REPORT_LIMIT");
        else stderr += b;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else done({ code, stdout, stderr });
      });
    },
  );
}
export async function verifyC2pa(input: Uint8Array): Promise<C2paReport> {
  if (!input.length || input.length > C2PA_MAX_BYTES)
    throw Error("C2PA_ASSET_SIZE_LIMIT");
  const bytes = Buffer.from(input);
  const media = c2paMedia(bytes),
    executable = binary(),
    policy = trustPolicy();
  return pool.run(async () => {
    const dir = await mkdtemp(join(tmpdir(), "contentproof-c2pa-"));
    try {
      await chmod(dir, 0o700);
      // The native reader chooses format by filename. A fixed basename prevents attacker-controlled paths.
      await writeFile(join(dir, `asset.${media.extension}`), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify(c2paSettings(policy.anchors)),
        { flag: "wx", mode: 0o600 },
      );
      const result = await invoke(executable, dir, media.extension);
      const base = {
        sha256: sha(bytes),
        mediaType: media.mediaType,
        policySha256: policy.policySha256,
      };
      if (result.code !== 0) {
        if (
          /No claim found|must fetch remote manifests from url|Remote manifest.*(disabled|not fetched)|RemoteManifestFetch/i.test(
            result.stderr,
          )
        )
          return {
            ...base,
            protocol: "c2pa",
            verifier: "c2patool/0.28.2",
            scope: "embedded-offline",
            outcome: "incomplete",
            integrity: "unknown",
            trust: policy.policySha256 ? "unknown" : "not-configured",
            revocation: "online-not-checked",
            identityAssertions: "not-checked",
            activeManifest: null,
            signer: null,
            findings: [
              {
                code: "C2PA_EMBEDDED_MANIFEST_UNAVAILABLE",
                severity: "informational",
              },
            ],
          };
        throw Error("C2PA_ASSET_UNREADABLE");
      }
      try {
        return normalizeC2pa(JSON.parse(result.stdout), base);
      } catch {
        throw Error("C2PA_REPORT_INVALID");
      }
    } finally {
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });
}
