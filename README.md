# 内容证链 · ContentProof

登录入口已独立为 `/login`：先解锁身份并登录，再进入工作空间；退出或会话失效返回登录页。211项回归及公网复核通过，网页独立发布未重启后台与长测。[登录入口与发布记录](docs/LOGIN_ENTRY_2026-10-25.md)。

最新：历史图片隔离服务已上线，Linux安全专项、历史图复算和公网业务复核通过。异机恢复及生产Vault部署工具已准备，实际外部验收仍待资源；原长测失败已保留，最终包需重新验收。[隔离与部署准备记录](docs/ISOLATION_DEPLOYMENT_2026-10-25.md)。

本轮高优先级修复：官方模块节点兼容迁移、权限失败清除旧详情已完成；本地205项回归通过，严重/高危/中危依赖告警为0，仍有35项低危。云端最终发布及24小时状态以[最新验收记录](docs/HIGH_PRIORITY_2026-10-25.md)为准；下文保留各轮历史快照。

2026-10-25后续修复：兼容依赖更新已上线，202项回归、7组链集成和8组真实权限专项通过；Windows/Ubuntu隔离短测通过，独立云端24小时测试已启动但未完成。33项Ganache告警及4项许可原文缺口仍开放。[最新处理与验收范围](docs/REMEDIATION_2026-10-25.md)。

默认使用真实用户持钥流程：浏览器加密身份、挑战登录、本地签署、图片编辑、链上登记、机构协作、披露导出和独立核验。演示模式需显式启用，不是默认入口。

2026-10-25更新：手机签署与最近声明提示修复已上线；安卓夸克由用户确认签署上链、首页显示及详情打开正常。Windows 199项回归、云端6组集成和公网11项检查通过。范围与证据见[手机验收记录](docs/MOBILE_SIGNING_FIX_2026-10-25.md)，依赖升级及历史复算边界见[引擎说明](docs/MEDIA_ENGINES.md)。

## 启动

要求 Node.js 22.13+，本轮 Windows 验证 22.23.1。首次安装需要网络。

```powershell
npm.cmd ci
npm.cmd run dev
```

打开 http://127.0.0.1:5173 ，创建加密身份并设置至少 12 位口令，保存加密身份备份。口令与用户私钥不发送服务端。默认数据在 data/app，持久化节点使用随机费用账户；Ctrl+C 关闭本次服务，重启保留登记。清理浏览器或改变网页来源前先备份身份，服务端不能恢复遗失的用户签名私钥。

图片支持 PNG/JPEG 导入和裁剪、缩放、旋转、合成；签名绑定实际文件、操作、参数及有序父节点。AI 标签是签名者声明，不是模型服务方认证。身份页提供独立声明密钥、epoch 授权、停用、撤销、备份和审计。

签署前会用浏览器保留的草稿重新核对字段、参数和有序父承诺，并显示页面内确认窗口。首次使用需核对链及合约；登记网络变化时，在身份页明确重新确认。旧浏览器草稿若没有本地签署快照，需要重新创建；此检查以浏览器和前端代码可信为前提。缺少历史存储密钥时服务会停止启动，必须恢复原密钥，不能生成新密钥替代。

编译部署可用同一 supervisor，不需要 Vite/tsx：

```powershell
npm.cmd run build
npm.cmd run start:local
```

网页/API 地址 http://127.0.0.1:3001 。首次自动部署，已有部署复用。3001 与 5173 是不同浏览器来源，使用加密备份迁移身份。npm start 只运行编译 API，需另行提供链及已有部署。

## 机构与权限

机构页支持申请、凭证摘要、人工审批、成员邀请/接受及 owner/admin/editor/viewer。OPERATOR_ADDRESSES 设置审核人公开钱包地址，审核人不能自审；真实资质需人工核对。素材可授权只读或编辑，个人授权可设置到期时间；声明及素材分别撤销。素材所有者控制再授权，已经下载的内容无法收回。

网页新增“运行状态”查看持续异常及恢复历史；图片任务由独立进程执行。接口响应由运行时严格契约验证，完整定义见 docs/openapi.json。

## 部署及维护

环境变量不会自动从 .env 加载，示例见 .env.example。PORT、WEB_PORT、RPC_URL、RPC_URLS、CHAIN_MODE、CHAIN_ID、AUTH_AUDIENCE、ALLOWED_ORIGINS 等由共享配置解析。外部 RPC 和独立费用账户可配置；STORAGE_KEY_FILE、RELAYER_PRIVATE_KEY_FILE 可由编译 supervisor 读取，不打印密钥。REGISTRATION_MODE=closed 关闭自助身份登记。

非 root Docker 部署、四节点 Besu QBFT、RPC 备用源、停机加密备份/新目录恢复/密钥轮换/孤儿清理的具体命令见 [运维说明](docs/OPERATIONS.md)。可写外置文件 secret 已支持带恢复日志的轮换；Vault KV v2 已接入并完成真实本机验收，KV v2数据重加密和Transit信封/主密钥升级已完成Windows/Linux各12项真实验收，云KMS、生产HA/TLS及跨机构部署仍待完成。本地 Ganache 7.9.2 已归档，仅用作参考节点；受维护的 Besu 网络有单独部署入口及同机故障验收，不能据此宣称完成跨机构生产部署。

## 验证与交付

补充处理：来源图按需加载、备份保留预览和磁盘告警已实现，当前本机193项回归通过；许可、长测与外部验收剩余情况见[其他问题台账](docs/REMAINING_WORK_2026-10-25.md)。

2026-10-25修复本轮审查8项缺陷，当前Windows190项回归及真实故障/灾备检查通过；准确范围、兼容性与仍开放事项见[修复记录](docs/AUDIT_FIXES_2026-10-25.md)。下方双平台170项为上一轮记录，不能当作本轮Linux重新验收。

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:reliability
npm.cmd run test:audit-fixes
npm.cmd run bench:protocol
npm.cmd run test:media-vectors
npm.cmd run release
```

最新 Windows 及 Linux 各通过 170 项测试；编译版备份恢复及内外置文件密钥轮换共 9 项、当前 Windows/Linux 非 demo 完整业务各 8 项通过。上一轮四节点共识 5 项和 RPC 故障切换记录仍按原范围有效。协议规模测试不能当作链/图片吞吐。详见 [当前状态](IMPLEMENTATION_STATUS.md) 和 [本轮工程记录](docs/LOCAL_ENGINEERING_UPDATE_2026-10-23.md)。

独立 CLI：

```powershell
npm.cmd run verify:built -- verify evidence.zip --json
npm.cmd run verify:built -- verify evidence.zip --offline --policy configs/verification-policy.json --json
```

策略必须设置自己认可的 issuer/chain/contract。离线执行本地信任策略但不能检查最新链状态。退出码 0=全部满足，1=失败，2=输入/运行错误，3=证据/在线检查不完整。部分披露不能显示完整验证通过。

release 先执行当前测试/类型检查/编译构建，再生成 release/ContentProof.zip 和 SHA256SUMS；包内有源码、编译产物、选定记录和逐文件摘要，排除运行数据库、密钥、身份备份及本机路径。生产 npm SBOM/许可证在 docs/，OS 镜像及仍有 4 个缺完整许可原文的组件仍需复核。

只有显式 DEMO_MODE=true 或 dev:demo 启用公共测试身份，历史 demo 命令使用独立数据。系统不证明画面事实、版权或模型方认证。C2PA 完整兼容、视频/音频、ZK、水印、可信时间戳等 P3 仍未完整实现；参赛 PDF/PPT/录像按用户要求不制作。

第四轮补充真实回滚/租约恢复、10 分钟 40 次完整业务、QBFT 基本网络分区及 Windows/Linux 各 18 个编码向量。重跑方式、结果和边界见 [本机验收记录](docs/LOCAL_VALIDATION_2026-10-23.md)。

第六轮新增核心浏览器业务12项、钱包切换安全回归、本机真实Vault 5项、连续三分支回滚4项及可持续记录的长测工具，见 [逐项补全记录](docs/COMPLETION_PROGRESS_2026-10-24.md)、[Vault接入](docs/VAULT.md) 和 [剩余台账](COMPLETION_TRACKER.md)。24小时验收以最终实际报告为准，运行中不能标为通过。

第七轮补齐KV v2阶段恢复、Transit信封和主密钥升级，修复恢复目录短暂占用时的发布处理；详见 [密钥管理验收](docs/KEY_ROTATION_COMPLETION_2026-10-24.md)。上一轮长测已如实归档为中断，本轮重启结果以当前进度和最终报告为准。

第八轮新增[原生C2PA内嵌离线验证](docs/C2PA.md)：PNG/JPEG/WAV/MP4实际文件读取与绑定、证书信任分离、独立CLI和页面；Windows与兼容Linux各15项真实检查通过。完整C2PA、音视频受控编辑链及其他研究扩展仍按台账记录。详见[本轮验收](docs/C2PA_COMPLETION_2026-10-24.md)。

第九轮完成一台2核2GiB Ubuntu24.04云主机的单机部署、正式公网IP HTTPS及自动续期，8项真实业务/4项重启持久化和备份恢复已验收。小内存图片并发可配置，新增5项回归。详见[云端部署说明](docs/CLOUD_DEPLOYMENT.md)。多机构共识和高可用仍按台账记录。
