export function verificationFileError(name: string) {
  if (/\.json$/i.test(name))
    return "JSON是核验结果报告或身份备份，不能重新核验内容。请从声明详情的“设置披露与导出”下载ZIP证据包后上传。";
  if (!/\.zip$/i.test(name))
    return "请选择ZIP证据包；图片的内嵌凭证请使用下方的原生C2PA核验。";
  return "";
}
export function verificationExplanation(report: {
  outcome: string;
  checks: Record<string, string>;
}) {
  if (report.checks.anchor === "withdrawn")
    return "这条声明已被撤回，因此整体核验不通过。文件匹配、签名有效或编辑复算一致，都不会恢复其链上有效状态。";
  if (["revoked", "retired"].includes(report.checks.identity))
    return "签署身份的密钥已撤销或停用，请结合核验报告中的链上状态判断，不能只看文件或签名是否匹配。";
  if (report.outcome === "incomplete")
    return "部分证据未提供或检查无法完成，当前不能确认全部核验条件。请查看各项状态及检查理由。";
  if (report.outcome === "fail")
    return "至少一项核验未通过，请查看不匹配项和检查理由；重新下载报告不会改变原始证据或链上状态。";
  return "本次提供的证据满足核验条件。此结论针对文件、签名与来源记录，不证明内容符合事实；链上状态以后仍可能变化。";
}
