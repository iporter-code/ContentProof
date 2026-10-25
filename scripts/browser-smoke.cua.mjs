// Execute inside the documented CUA JavaScript browser runtime, passing its
// authenticated tab and viewport capability. No private keys or tokens saved.
export async function navigationAudit(tab, viewport) {
  const results = [];
  for (const width of [375, 768, 1280]) {
    await viewport.set({ width, height: 900 });
    for (const page of [
      "总览",
      "素材库",
      "编辑与签名",
      "声明记录",
      "独立验证",
      "身份与密钥",
      "组织与权限",
      "运行状态",
      "攻击实验",
    ]) {
      await tab.playwright
        .getByRole("link", { name: new RegExp(page + "$") })
        .click();
      const state = await tab.playwright.domSnapshot();
      const size = await tab.playwright.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        headings: [...document.querySelectorAll("h1")].map(
          (x) => x.textContent,
        ),
      }));
      results.push({
        width,
        page,
        ...size,
        passed:
          size.scroll <= size.viewport + 1 &&
          size.headings.length > 0 &&
          !state.includes("RESPONSE_CONTRACT_VIOLATION"),
      });
    }
  }
  return {
    date: new Date().toISOString(),
    passed: results.every((r) => r.passed),
    results,
    scope:
      "Authenticated navigation/render/whole-document horizontal overflow checks at three viewport widths. Uses actual application and API. Not full transactional browser automation, wallet compatibility or physical mobile devices.",
  };
}
