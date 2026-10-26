# 2026-10-26 技术复核记录

本页是一次修复的证据说明；当前结论统一见 [CURRENT_STATUS](CURRENT_STATUS.md)。

## 修复

发布流程将旧验收标记为失效，重新运行检查/编译，包含工作流与Git属性，写入源码提交和工作区状态。生成ZIP后核对全部内部摘要与当前源码/编译文件，最后才写本次 `verification.json`；独立入口 `npm run release:verify` 可拒绝源码变化后的旧包。旧日期的选定报告保留其原始范围。

Vault目录移动对 `EPERM/EACCES/EBUSY` 最多重试5次，每次重新核对无链接、目标不存在和密钥标记。持续拒绝仍报错，保留恢复日志、引用和原数据；不改变权限、不复制删除替代移动。测试构造阶段另有有限等待。配置实际为单worker，37个测试文件不代表同时37个worker。

C2PA状态、原生程序校验、报告和schema统一读取原生工具pin；仍使用原版本及校验摘要，没有升级原生依赖。补充修复状态接口严格响应契约的遗漏：使用同一 `C2PA_VERSION`，回归测试模拟pin升级，实际通过Fastify序列化钩子，并确认旧版本响应仍被拒绝。

## CSP

`configs/browser-security.json` 同时用于API响应和Nginx配置生成。限制同源脚本，禁止内联脚本、eval、对象和嵌框；保留blob图片、同源API及图片预览。样式属性单独允许，样式文件仍限定同源，以兼容ReactFlow布局。CSP是纵深防护，不能替代XSS修复或保护已被攻陷页面中的解锁材料。

策略参考 [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)、[style-src-attr](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr) 和 [Nginx响应头继承](https://nginx.org/en/docs/http/ngx_http_headers_module.html)。使用共享include及 `always`，代理隐藏上游重复头，资产location不另设 `add_header` 覆盖继承。

本地实际浏览器已验证6项：内联脚本、eval、跨源脚本被阻止；同源API、blob读取和图片预览可用。正常身份恢复登录、来源图等另按实际页面核查。API回归覆盖正常响应、入口、401、403和404的安全头。

数据盘点与保留规则见 [DATA_RETENTION](DATA_RETENTION.md)。用户选择保持公开性、许可证和历史提交现状；本轮未改仓库可见性、添加开源授权或重写历史。

## 原始证据

本地忽略目录 `data/repo-audit-2026-10-26/` 保存数据盘点、浏览器证据、原生C2PA检查及发布复核；发布包自身记录源码提交、摘要和验证结果，远端CI按对应提交核查。尚未结束的冻结24小时轮次仍独立保留，不将其宣称为本次新包完整长测。
