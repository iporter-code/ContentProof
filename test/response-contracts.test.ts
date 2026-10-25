import { it, expect } from "vitest";
import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  responseContracts,
  binaryContracts,
  validateResponse,
  registerResponseContracts,
} from "../apps/api/contracts.js";
it("every documented API has a strict JSON or explicit binary response and all internal refs resolve", () => {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/openapi.ts"], {
    windowsHide: true,
    stdio: "pipe",
  });
  const doc = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
  for (const [path, methods] of Object.entries(doc.paths) as any) {
    for (const [method, operation] of Object.entries(methods) as any) {
      const key = `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g, ":$1")}`;
      if (key === "GET /v1/openapi.json") continue;
      expect(Boolean(responseContracts[key] || binaryContracts[key]), key).toBe(
        true,
      );
      if (responseContracts[key]) {
        const schema =
          operation.responses[200].content["application/json"].schema;
        expect(schema.additionalProperties, key).toBe(false);
        expect(Object.keys(schema.properties.data).length, key).toBeGreaterThan(
          0,
        );
      }
    }
  }
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.$ref?.startsWith("#/")) {
      let target: any = doc;
      for (const part of node.$ref.slice(2).split("/"))
        target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      expect(target, node.$ref).toBeDefined();
    }
    Object.values(node).forEach(walk);
  }
  walk(doc);
});
it("domain responses reject extra fields, wrong types and unknown enum values", () => {
  expect(() =>
    validateResponse("GET", "/v1/stats", 200, {
      data: { assets: 1, claims: 1, secret: "leak" },
    }),
  ).toThrow();
  expect(() =>
    validateResponse("GET", "/v1/stats", 200, {
      data: { assets: "1", claims: 1 },
    }),
  ).toThrow();
  expect(() =>
    validateResponse("GET", "/v1/system/health", 200, {
      data: { workerError: null, indexerError: null, privateKey: "leak" },
    }),
  ).toThrow();
  expect(() =>
    validateResponse("GET", "/v1/new-unregistered-api", 200, { data: {} }),
  ).toThrow("MISSING");
  expect(
    validateResponse("GET", "/health/ready", 503, {
      data: { database: true, chain: false, demoMode: false },
    }),
  ).toHaveProperty("data.chain", false);
});
it("invalid server output fails closed before serialization and does not leak extra properties", async () => {
  const app = Fastify();
  registerResponseContracts(app);
  app.setErrorHandler((error: any, _req, reply) =>
    reply
      .code(500)
      .send({ error: { code: error.code, message: "INTERNAL_ERROR" } }),
  );
  app.get("/v1/stats", () => ({
    data: { assets: 1, claims: 1, secret: "must-not-leak" },
  }));
  try {
    const r = await app.inject({ url: "/v1/stats" });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain("must-not-leak");
    expect(r.json().error.code).toBe("RESPONSE_CONTRACT_VIOLATION");
  } finally {
    await app.close();
  }
});
