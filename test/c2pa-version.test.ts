import { afterEach, expect, it, vi } from "vitest";
import nativeTools from "../configs/native-tools.json" with { type: "json" };
import Fastify from "fastify";

afterEach(() => {
  vi.doUnmock("../configs/native-tools.json");
  vi.resetModules();
});

it("a changed pin passes the status endpoint serialization contract and rejects a stale version", async () => {
  vi.resetModules();
  vi.doMock("../configs/native-tools.json", () => ({
    default: { c2patool: { ...nativeTools.c2patool, version: "9.8.7" } },
  }));
  const { c2paAvailability } = await import("../packages/c2pa/index.js");
  const { registerResponseContracts } =
    await import("../apps/api/contracts.js");
  const app = Fastify();
  registerResponseContracts(app);
  app.setErrorHandler((error: any, _req, reply) =>
    reply
      .code(500)
      .send({ error: { code: error.code, message: "INTERNAL_ERROR" } }),
  );
  let status = c2paAvailability();
  app.get("/v1/verify/c2pa/status", () => ({ data: status }));
  try {
    const response = await app.inject({ url: "/v1/verify/c2pa/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(status);
    expect(response.json().data.version).toBe("9.8.7");
    status = { ...status, version: nativeTools.c2patool.version };
    const stale = await app.inject({ url: "/v1/verify/c2pa/status" });
    expect(stale.statusCode).toBe(500);
    expect(stale.json().error.code).toBe("RESPONSE_CONTRACT_VIOLATION");
  } finally {
    await app.close();
  }
});

it("a changed native tool pin changes availability and the accepted report version together", async () => {
  vi.resetModules();
  vi.doMock("../configs/native-tools.json", () => ({
    default: {
      c2patool: { ...nativeTools.c2patool, version: "9.8.7" },
    },
  }));
  const { C2PA_VERIFIER } = await import("../packages/c2pa/version.js");
  const { c2paAvailability } = await import("../packages/c2pa/index.js");
  const { c2paReportSchema } = await import("../packages/c2pa/report.js");
  expect(c2paAvailability()).toMatchObject({
    available: false,
    version: "9.8.7",
  });
  expect(C2PA_VERIFIER).toBe("c2patool/9.8.7");
  const verifier = c2paReportSchema.shape.verifier;
  expect(verifier.safeParse(C2PA_VERIFIER).success).toBe(true);
  expect(
    verifier.safeParse(`c2patool/${nativeTools.c2patool.version}`).success,
  ).toBe(false);
});
