import { z } from "zod";
import { C2PA_VERIFIER } from "./version.js";

export const c2paReportSchema = z.strictObject({
  protocol: z.literal("c2pa"),
  verifier: z.literal(C2PA_VERIFIER),
  scope: z.literal("embedded-offline"),
  outcome: z.enum(["pass", "fail", "incomplete"]),
  integrity: z.enum(["valid", "invalid", "unknown"]),
  trust: z.enum(["operator-trusted", "untrusted", "not-configured", "unknown"]),
  revocation: z.literal("online-not-checked"),
  identityAssertions: z.literal("not-checked"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.enum(["image/png", "image/jpeg", "audio/wav", "video/mp4"]),
  activeManifest: z.string().max(1024).nullable(),
  signer: z
    .strictObject({
      issuer: z.string().max(1024),
      commonName: z.string().max(1024),
      algorithm: z.string().max(100),
    })
    .nullable(),
  policySha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  findings: z
    .array(
      z.strictObject({
        code: z.string().max(200),
        severity: z.enum(["success", "informational", "failure"]),
      }),
    )
    .max(2000),
});
export type C2paReport = z.infer<typeof c2paReportSchema>;

// The caller obtains this report from the pinned executable, never from an uploaded JSON report.
export function normalizeC2pa(
  raw: unknown,
  base: Pick<C2paReport, "sha256" | "mediaType" | "policySha256">,
): C2paReport {
  const entry = z.object({ code: z.string().min(1).max(200) }).passthrough();
  const groups = z
    .object({
      success: z.array(entry),
      informational: z.array(entry),
      failure: z.array(entry),
    })
    .passthrough();
  const native = z
    .object({
      active_manifest: z.string().max(1024),
      manifests: z.record(
        z.string(),
        z
          .object({
            signature_info: z
              .object({
                issuer: z.string().max(1024).optional(),
                common_name: z.string().max(1024).optional(),
                alg: z.string().max(100).optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      ),
      validation_state: z.enum(["Valid", "Invalid", "Trusted"]),
      validation_status: z.array(entry).optional(),
      validation_results: z
        .object({
          activeManifest: groups,
          ingredientDeltas: z
            .array(z.object({ validationDeltas: groups }).passthrough())
            .optional(),
        })
        .passthrough(),
    })
    .passthrough()
    .parse(raw);
  if (!Object.hasOwn(native.manifests, native.active_manifest))
    throw Error("C2PA_REPORT_ACTIVE_MANIFEST_MISSING");
  const findings: C2paReport["findings"] = [];
  const collect = (g: z.infer<typeof groups>) => {
    for (const severity of ["success", "informational", "failure"] as const)
      for (const item of g[severity])
        findings.push({ code: item.code, severity });
  };
  collect(native.validation_results.activeManifest);
  for (const delta of native.validation_results.ingredientDeltas ?? [])
    collect(delta.validationDeltas);
  for (const item of native.validation_status ?? [])
    if (!findings.some((x) => x.code === item.code && x.severity === "failure"))
      findings.push({ code: item.code, severity: "failure" });
  const failures = findings.filter((x) => x.severity === "failure");
  const invalid =
    failures.some((x) => x.code !== "signingCredential.untrusted") ||
    native.validation_state === "Invalid";
  const success = new Set(
    native.validation_results.activeManifest.success.map((x) => x.code),
  );
  const signature = success.has("claimSignature.validated");
  const binding = [
    "assertion.dataHash.match",
    "assertion.bmffHash.match",
    "assertion.boxesHash.match",
  ].some((x) => success.has(x));
  const integrity = invalid
    ? "invalid"
    : signature && binding
      ? "valid"
      : "unknown";
  const trust = !base.policySha256
    ? "not-configured"
    : native.validation_state === "Trusted" &&
        success.has("signingCredential.trusted") &&
        !failures.some((x) => x.code === "signingCredential.untrusted")
      ? "operator-trusted"
      : "untrusted";
  const sig = native.manifests[native.active_manifest].signature_info;
  return c2paReportSchema.parse({
    ...base,
    protocol: "c2pa",
    verifier: C2PA_VERIFIER,
    scope: "embedded-offline",
    outcome: invalid
      ? "fail"
      : integrity === "valid" &&
          trust === "operator-trusted" &&
          failures.length === 0
        ? "pass"
        : "incomplete",
    integrity,
    trust,
    revocation: "online-not-checked",
    identityAssertions: "not-checked",
    activeManifest: native.active_manifest,
    signer: sig
      ? {
          issuer: sig.issuer ?? "",
          commonName: sig.common_name ?? "",
          algorithm: sig.alg ?? "",
        }
      : null,
    findings,
  });
}
