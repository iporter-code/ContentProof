import { it, expect, vi, afterEach } from "vitest";
const events: string[] = [];
const items = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
  value: {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => items.set(k, v),
    removeItem: (k: string) => items.delete(k),
  },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {
    dispatchEvent: (e: Event) => {
      events.push(e.type);
      return true;
    },
  },
  configurable: true,
});
import { api, waitForJob, downloadBundle } from "../apps/web/src/api.js";
afterEach(() => vi.unstubAllGlobals());
it("export resumes an existing completed task without creating a second job", async () => {
  const target = `0x${"11".repeat(32)}`,
    input = { target, hideFields: [], hideParents: [] },
    paths: string[] = [];
  items.set(
    `cp-export:${target}`,
    JSON.stringify({ id: "saved-job", input: JSON.stringify(input) }),
  );
  vi.stubGlobal("fetch", async (path: string) => {
    paths.push(path);
    if (path.endsWith("/content")) return new Response("zip-bytes");
    return new Response(
      JSON.stringify({
        data: path.endsWith("/preview")
          ? {}
          : { id: "saved-job", state: "completed", progress: 100 },
      }),
    );
  });
  expect(await (await downloadBundle(target)).text()).toBe("zip-bytes");
  expect(paths).not.toContain("/v1/exports");
  expect(paths).toContain("/v1/exports/saved-job/content");
});
it("BUG12 clears expired session and announces relogin", async () => {
  items.set("cp-token", "expired");
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: { message: "UNAUTHORIZED" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
  );
  await expect(api("/v1/assets")).rejects.toThrow("UNAUTHORIZED");
  expect(items.has("cp-token")).toBe(false);
  expect(events).toContain("cp-session-expired");
});
it("BUG10 polling rejects withdrawn and orphaned jobs instead of reporting success", async () => {
  for (const state of ["withdrawn", "orphaned"]) {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ data: { state } }), { status: 200 }),
    );
    await expect(waitForJob("job")).rejects.toThrow(state);
  }
});
it("a delayed 401 from the previous session cannot clear a newly established login", async () => {
  let reply!: (value: Response) => void;
  items.set("cp-token", "previous-session");
  const eventCount = events.length;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      }),
  );
  const request = api("/v1/assets");
  items.set("cp-token", "new-session");
  reply(
    new Response(JSON.stringify({ error: { message: "UNAUTHORIZED" } }), {
      status: 401,
    }),
  );
  await expect(request).rejects.toThrow("UNAUTHORIZED");
  expect(items.get("cp-token")).toBe("new-session");
  expect(events.length).toBe(eventCount);
});
