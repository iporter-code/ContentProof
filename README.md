# 内容证链 · ContentProof

内容证链用于为图片签署声明、记录派生编辑、按需披露来源，并导出可独立核验的证据包。普通用户先在 `/login` 解锁本机身份，再进入工作空间。

**当前验收、已知问题与待办统一记录在 [当前有效状态](docs/CURRENT_STATUS.md)。** README 只维护使用说明；旧轮次测试数字与发布叙述已归档。

## 启动

要求 Node.js 22.13+；首次安装需要网络。

```powershell
npm.cmd ci
npm.cmd run dev
```

打开 http://127.0.0.1:5173 ，创建身份并设置至少12位口令，下载 `contentproof-identity.encrypted.json` 加密备份。口令和用户私钥不发送服务端。清理浏览器数据、切换浏览器或网页来源前先备份；服务端不能恢复遗失的用户私钥。

编译运行：

```powershell
npm.cmd run build
npm.cmd run start:local
```

网页/API 地址为 http://127.0.0.1:3001 。3001 与5173是不同浏览器来源，迁移身份需恢复加密备份并使用原口令。首次自动部署，后续复用 `data/app` 中的持久化链和登记；已有数据缺少存储密钥时停止启动，不生成替代密钥。

## 使用范围

支持 PNG/JPEG 上传、裁剪、缩放、旋转与合成；签名绑定实际文件、操作、参数、有序父节点和链域。签署前核对页面中的声明；取消保留草稿。组织支持人工审批、邀请和 owner/admin/editor/viewer 权限。

证据核验上传从声明详情导出的 ZIP。`verification-report.json` 只保存检查结果，不能代替证据包或身份备份。撤回状态、披露完整性、文件与签名分别呈现；部分披露不显示完整验证通过。

签名证明声明来源，不证明画面事实、版权或模型方认证。原生 C2PA 支持内嵌离线核验，不等于完整 C2PA/音视频编辑链。生产跨机构共识、KMS/Vault高可用及异机恢复按实际验收范围记录。

## 检查与交付

```powershell
npm.cmd test
npm.cmd run format:check
npm.cmd run build
npm.cmd run release
npm.cmd run release:verify
npm.cmd run data:inventory
```

发布脚本先重新验证与构建，再生成 `release/ContentProof.zip`、`SHA256SUMS` 和 `verification.json`。包内 `RELEASE.json` 记录源码提交及工作区状态；校验覆盖内外摘要、源码/编译产物字节和运行数据排除。历史证据保留其原日期与范围，不代表本次重新运行。

`data/`、`release/`、运行时及密钥不进入 Git。`data:inventory` 只盘点元数据，不删除或移动文件；保留和异地归档规则见 [数据保留](docs/DATA_RETENTION.md)。

独立 CLI：

```powershell
npm.cmd run verify:built -- verify evidence.zip --json
npm.cmd run verify:built -- verify evidence.zip --offline --policy configs/verification-policy.json --json
```

策略需设置认可的 issuer/chain/contract。离线验证不能读取最新链状态。退出码0=满足策略，1=核验失败，2=输入/运行错误，3=检查不完整。

## 部署与文档

环境变量不自动从 `.env` 加载，示例见 `.env.example`。外部 RPC、密钥文件及 Vault 配置须按运维说明设置；真实机构资质由人工核对。demo需显式启用，默认关闭。

- [文档入口](docs/README.md)
- [运维与备份恢复](docs/OPERATIONS.md)
- [单机云端部署](docs/CLOUD_DEPLOYMENT.md)
- [身份与存储密钥管理](docs/VAULT.md)
- [设计说明](docs/DESIGN_REPORT.md)
- [历史 README](docs/archive/README_2026-10-26.md)
