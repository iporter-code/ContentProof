import { it, expect } from "vitest";
import { trustedProxies } from "../packages/config/proxy.js";
it("proxy trust is explicit and rejects arbitrary trust functions or malformed networks", () => {
  expect(trustedProxies("")).toBe(false);
  expect(trustedProxies("127.0.0.1/32,::1/128")).toEqual([
    "127.0.0.1/32",
    "::1/128",
  ]);
  for (const value of [
    "true",
    "*",
    "127.0.0.1/33",
    "::1/129",
    "127.0.0.1/-1",
    "127.0.0.1/",
    "127.0.0.1/32/other",
  ])
    expect(() => trustedProxies(value)).toThrow("INVALID_TRUSTED_PROXIES");
});
