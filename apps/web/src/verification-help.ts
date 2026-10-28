export function verificationFileError(name: string) {
  if (/\.json$/i.test(name))
    return "JSON是核验结果报告或身份备份，不能重新核验内容。请从声明详情的“设置披露与导出”下载ZIP证据包后上传。";
  if (!/\.zip$/i.test(name))
    return "请选择ZIP证据包；图片的内嵌凭证请使用下方的原生C2PA核验。";
  return "";
}
export function verificationExplanation(report: {
  claimId?: string;
  outcome: string;
  checks: Record<string, string>;
  reasons?: VerificationReason[];
}) {
  if (
    report.outcome === "fail" &&
    report.reasons?.some(
      (reason) =>
        reason.code === "CHAIN_OR_IDENTITY_REJECTED" &&
        isUpstreamReason(reason, report.claimId),
    )
  )
    return "上游来源声明的链上登记或密钥核验未通过，因此整体核验失败。下方分项不会逐一列出上游状态，请核对检查理由中列出的上游声明。";
  if (report.checks.anchor === "withdrawn")
    return "这条声明已被撤回，因此整体核验不通过。文件匹配、签名有效或编辑复算一致，都不会恢复其链上有效状态。";
  if (report.checks.identity === "revoked")
    return "签署身份的密钥已撤销，整体核验不通过；文件匹配或原签名有效不能恢复密钥有效状态。";
  if (report.checks.identity === "retired" && report.outcome === "pass")
    return "该签名密钥已停用，不能签署新声明；这条声明在停用前已有效登记，本次历史证据仍满足核验条件。";
  if (report.outcome === "incomplete")
    return "部分证据未提供或检查无法完成，当前不能确认全部核验条件。请查看各项状态及检查理由。";
  if (report.outcome === "fail")
    return "至少一项核验未通过，请查看不匹配项和检查理由；重新下载报告不会改变原始证据或链上状态。";
  return "本次提供的证据满足核验条件。此结论针对文件、签名与来源记录，不证明内容符合事实；链上状态以后仍可能变化。";
}

export type VerificationReason = {
  code: string;
  claimId?: string;
  message: string;
};
export function isUpstreamReason(reason: VerificationReason, root?: string) {
  return (
    !!root &&
    !!reason.claimId &&
    reason.claimId.toLowerCase() !== root.toLowerCase()
  );
}
export function verificationReasonText(reason: VerificationReason) {
  const descriptions: Record<string, string> = {
    CHAIN_OR_IDENTITY_REJECTED:
      "链上登记或签署密钥状态未通过核验，请查看该声明的当前链上状态。",
    PARENT_WITHHELD: "此来源已被隐藏，无法检查该路径上的完整来源证据。",
    TRANSFORM_UNAVAILABLE: "当前材料不足，无法独立复算这次编辑。",
    INVALID_SIGNER: "签名密钥与登记世代不匹配，或该世代已停用、撤销。",
  };
  return (
    descriptions[reason.code] ??
    (reason.message !== reason.code
      ? reason.message
      : `检查未通过（${reason.code}）`)
  );
}

export function userErrorMessage(code: string) {
  const descriptions: Record<string, string> = {
    INVALID_OPERATION_PARAMETER:
      "图片编辑参数无效，请检查坐标、宽高和角度是否在素材允许范围内。",
    INVALID_SIGNER:
      "当前签名密钥与所选世代不匹配，或该世代已停用、撤销。请在“身份与密钥”核对后重试。",
    FORBIDDEN: "当前身份没有此操作权限，请核对授权状态。",
  };
  return descriptions[code] ? `${descriptions[code]}（${code}）` : code;
}
