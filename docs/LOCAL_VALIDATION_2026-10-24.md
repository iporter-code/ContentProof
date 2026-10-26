# 归档：第五轮本机验收：容量与浏览器

<!-- archived-status-snapshot -->
> 已归档：只记录标题日期的验收与处理范围，文中的测试数量、运行中或未推送描述均为历史事实。当前有效状态统一见[CURRENT_STATUS](CURRENT_STATUS.md)。

本轮使用合成图片和已有临时验收身份，不执行用户暂缓的限时授权提交，不制作参赛材料。

## 容量突发与恢复

新增 scripts/test-capacity.ts / npm.cmd run test:capacity。新建隔离数据目录及 3084/8584 服务，上传 2048×1536 合成 PNG；1、2、4、8、16 并发分别重复两轮。62 个突发请求中 18 次成功、44 次收到明确的资源繁忙响应；1/2 并发全部成功。每轮检查图片任务/队列归零及服务就绪，最后再发一个上传请求成功。

这是验证当前“同时受理两个媒体请求”配置的背压和恢复，不能把拒绝数量当作处理吞吐，也不代表更大图片、链写入或多机的容量。不是 24 小时稳定性测试。报告为 data/app/results/capacity.json。

## 可复用浏览器自动巡检

新增 scripts/browser-smoke.cua.mjs，供已连接的 CUA 浏览器运行时调用 navigationAudit(tab, viewport)。先由操作者解锁自己的测试身份；脚本不存口令、私钥或 token。实际执行 375、768、1280 三种视口下的 9 个页面，共 27 项检查通过，包括导航、主标题呈现、错误契约提示及整页横向溢出检查。

示例在 CUA JavaScript 运行时执行：

```javascript
const audit = await import('file:///YOUR_WORKSPACE/scripts/browser-smoke.cua.mjs');
const report = await audit.navigationAudit(tab, viewport);
```

tab 与 viewport 来自浏览器工具支持的连接和视口能力，不是任意网页脚本。完成后应恢复视口、锁定身份并关闭临时预览。本轮已经执行这些清理，未创建新的权限授予。

报告为 data/app/results/browser-responsive.json，窄屏截图为 browser-mobile-2026-10-24.png。本轮是页面层自动化巡检，不是全业务事务自动化：签署确认、钱包扩展、组织审批、权限授予、导出下载等完整交互仍需补齐。视口模拟不等同于真实手机设备兼容。

## 仍开放

完整浏览器业务自动化、外部钱包与真实移动设备、24 小时测试与容量饱和研究、云 KMS/Vault、独立跨机构部署、复杂恶意节点及 P3 扩展仍未完成。4 项完整许可原文缺口也未在本轮消除。当前状态以 IMPLEMENTATION_STATUS.md 为准。
