import { expect, it } from "vitest";
import { consumeFileSelection } from "../apps/web/src/file-selection.js";
import { reviewKeyAction } from "../apps/web/src/key-action-review.js";
import {
  isUpstreamReason,
  verificationExplanation,
  verificationReasonText,
} from "../apps/web/src/verification-help.js";

it("rearms a native file input before async checking, retaining the selected file", () => {
  const file = new File(["synthetic evidence"], "evidence.zip");
  const input = {
    files: [file] as unknown as FileList,
    value: "C:\\fakepath\\evidence.zip",
  };
  expect(consumeFileSelection(input)).toBe(file);
  expect(input.value).toBe("");
  // A real picker now compares against the empty value, so the same path changes.
  input.value = "C:\\fakepath\\evidence.zip";
  expect(consumeFileSelection(input)).toBe(file);
  expect(input.value).toBe("");
  expect(consumeFileSelection({ files: null, value: "" })).toBeUndefined();
});

const primary = "0x1111111111111111111111111111111111111111";
const delegated = "0x2222222222222222222222222222222222222222";
const keys = [{ epoch: "2", record: [delegated, "10", "0", "0"] as const }];
it("reviews retire/revoke against the registered epoch, never the reset new-address field", () => {
  const retire = reviewKeyAction("retire", "2", primary, keys);
  const revoke = reviewKeyAction("revoke", "2", "not-an-address", keys);
  for (const review of [retire, revoke]) {
    expect(review.message).toContain(delegated);
    expect(review.message).not.toContain(primary);
    expect(review.request.signer).toBe(delegated);
    expect(Object.isFrozen(review.request)).toBe(true);
  }
  expect(retire.message).toContain("历史声明仍可核验");
  expect(retire.message).not.toContain("不可恢复");
  expect(revoke.message).toContain("历史声明将不再满足");
  expect(revoke.message).toContain("不可恢复");
});
it("fails closed on unknown epochs and prevents overwriting an existing authorization", () => {
  expect(() => reviewKeyAction("retire", "3", primary, keys)).toThrow("未找到");
  expect(() => reviewKeyAction("revoke", "2", primary, [])).toThrow("未找到");
  expect(() => reviewKeyAction("authorize", "2", primary, keys)).toThrow(
    "已经登记",
  );
  expect(() => reviewKeyAction("authorize", "3", "", keys)).toThrow("有效");
  const next = reviewKeyAction("authorize", "3", primary, keys);
  expect(next.request).toEqual({
    action: "authorize",
    epoch: "3",
    signer: primary,
  });
  expect(next.message).toContain("新签名地址");
  expect(next.message).not.toContain("不可恢复");
});
it("identifies upstream rejection even when every current-claim check is green", () => {
  const reason = {
    code: "CHAIN_OR_IDENTITY_REJECTED",
    claimId: "0xparent",
    message: "CHAIN_OR_IDENTITY_REJECTED",
  };
  const report = {
    claimId: "0xroot",
    outcome: "fail",
    checks: {
      anchor: "confirmed",
      identity: "active",
      transformation: "reproduced",
    },
    reasons: [reason],
  };
  expect(verificationExplanation(report)).toContain("上游来源");
  expect(isUpstreamReason(reason, report.claimId)).toBe(true);
  expect(
    isUpstreamReason({ ...reason, claimId: "0xROOT" }, report.claimId),
  ).toBe(false);
  expect(verificationReasonText(reason)).toContain("链上登记或签署密钥状态");
  expect(verificationReasonText(reason)).not.toContain(reason.code);
});
it("distinguishes historical validity after retirement from revoked-key failure", () => {
  expect(
    verificationExplanation({
      outcome: "pass",
      checks: { identity: "retired" },
    }),
  ).toContain("历史证据仍满足");
  expect(
    verificationExplanation({
      outcome: "fail",
      checks: { identity: "revoked" },
    }),
  ).toContain("整体核验不通过");
});
