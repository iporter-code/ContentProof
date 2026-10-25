// Runs only inside the connected CUA browser runtime. The operator unlocks an
// existing local test identity first. No credentials, sessions or keys exported.
export async function signedEdit(
  tab,
  { title, operation = "import", parent, width = 96, height = 72 },
) {
  await tab.playwright.getByRole("link", { name: /编辑与签名$/ }).click();
  await tab.playwright
    .getByRole("combobox", { name: "操作类型", exact: true })
    .selectOption(operation);
  await tab.playwright
    .getByRole("textbox", { name: "内容标题", exact: true })
    .fill(title);
  if (parent) {
    await tab.playwright
      .getByRole("combobox", { name: /输入素材 1/ })
      .selectOption(parent);
    if (operation === "resize" || operation === "crop") {
      await tab.playwright
        .getByRole("spinbutton", { name: "宽度", exact: true })
        .fill(String(width));
      await tab.playwright
        .getByRole("spinbutton", { name: "高度", exact: true })
        .fill(String(height));
    }
  }
  await tab.playwright
    .getByRole("button", { name: "执行、签名并上链 →", exact: true })
    .click();
  // Return at the consent boundary. The caller reads the displayed signing
  // operation/digest before accepting this synthetic test's confirmation.
  return { stage: "awaiting-signature-consent", title, operation };
}
export async function confirmedClaim(tab, title) {
  await tab.playwright
    .getByText(title, { exact: true })
    .waitFor({ state: "visible", timeoutMs: 45000 });
  await tab.playwright
    .getByText(/已上链确认/)
    .waitFor({ state: "visible", timeoutMs: 45000 });
  const url = await tab.url(),
    id = url?.match(/\/claims\/(0x[0-9a-f]{64})$/)?.[1];
  if (!id) throw Error("BROWSER_CLAIM_ROUTE_MISSING");
  return { id, url, title };
}
export async function exportedEvidence(tab) {
  await tab.playwright
    .getByRole("link", { name: "设置披露与导出 ↗", exact: true })
    .click();
  await tab.playwright
    .getByRole("heading", { name: "当前为完整披露", exact: true })
    .waitFor({ state: "visible" });
  return downloadDisclosure(tab);
}
export async function downloadDisclosure(tab) {
  const pending = tab.playwright.waitForEvent("download", { timeoutMs: 60000 });
  await tab.playwright
    .getByRole("button", { name: "导出真实证据包 ↓", exact: true })
    .click();
  const path = await (await pending).path({ timeoutMs: 60000 });
  if (!path) throw Error("BROWSER_EXPORT_NOT_DOWNLOADED");
  return path;
}
export async function verifyEvidence(tab, path) {
  await tab.playwright.getByRole("link", { name: /证据核验$/ }).click();
  const chooser = tab.playwright.waitForEvent("filechooser");
  await tab.playwright.getByLabel("上传证据包", { exact: true }).click();
  await (await chooser).setFiles(path);
  await tab.playwright
    .getByRole("heading", { name: "验证结果", exact: true })
    .waitFor({ state: "visible", timeoutMs: 60000 });
  // Return the visible evidence for operator assertions; never trust a bundle's
  // precomputed report or inspect authentication state inside the page.
  return tab.playwright.domSnapshot();
}
export async function downloadVerificationReport(tab) {
  const pending = tab.playwright.waitForEvent("download");
  await tab.playwright
    .getByRole("button", { name: "下载报告 JSON ↓", exact: true })
    .click();
  const path = await (await pending).path();
  if (!path) throw Error("BROWSER_REPORT_NOT_DOWNLOADED");
  return path;
}
