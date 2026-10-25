import { it, expect } from "vitest";
import { loginDestination } from "../apps/web/src/auth-navigation.js";
it("restores only local destinations and prevents login loops or external redirects", () => {
  expect(loginDestination("/claims/example?tab=details#signature")).toBe(
    "/claims/example?tab=details#signature",
  );
  for (const path of [
    undefined,
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/%2e%2e//evil.example",
    "/login",
    "/login/",
    "/login?next=//evil.example",
  ])
    expect(loginDestination(path)).toBe("/");
});
