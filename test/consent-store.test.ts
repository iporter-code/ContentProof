import { it, expect, afterEach } from "vitest";
import {
  requestConsent,
  consentSnapshot,
  settleConsent,
  cancelConsent,
  subscribeConsent,
} from "../apps/web/src/consent-store.js";
afterEach(cancelConsent);
it("consent remains pending until the displayed request is explicitly accepted", async () => {
  let resolved = false,
    changes = 0;
  const unsubscribe = subscribeConsent(() => changes++);
  const result = requestConsent("签署文件 A").then((value) => {
    resolved = true;
    return value;
  });
  const displayed = consentSnapshot()!;
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(displayed.message).toBe("签署文件 A");
  settleConsent(displayed.id + 1, true);
  expect(consentSnapshot()).toEqual(displayed);
  settleConsent(displayed.id, true);
  expect(await result).toBe(true);
  expect(consentSnapshot()).toBeNull();
  expect(changes).toBe(2);
  unsubscribe();
});
it("concurrent requests cannot replace reviewed content and stale approval cannot approve a new request", async () => {
  const first = requestConsent("A"),
    oldId = consentSnapshot()!.id;
  expect(await requestConsent("B")).toBe(false);
  expect(consentSnapshot()!.message).toBe("A");
  cancelConsent();
  expect(await first).toBe(false);
  const next = requestConsent("C"),
    nextId = consentSnapshot()!.id;
  settleConsent(oldId, true);
  expect(consentSnapshot()!.id).toBe(nextId);
  settleConsent(nextId, false);
  expect(await next).toBe(false);
});
