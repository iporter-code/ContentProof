import { afterEach, expect, it, vi } from "vitest";
import nativeTools from "../configs/native-tools.json" with { type: "json" };

afterEach(() => {
  vi.doUnmock("../configs/native-tools.json");
  vi.resetModules();
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
