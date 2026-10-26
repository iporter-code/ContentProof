# 归档：第六轮逐项补全记录

<!-- archived-status-snapshot -->
> 已归档：只记录标题日期的验收与处理范围，文中的测试数量、运行中或未推送描述均为历史事实。当前有效状态统一见[CURRENT_STATUS](CURRENT_STATUS.md)。

使用本机合成素材及已有临时测试身份。参赛材料排除；用户暂缓的浏览器限时授权不执行。

## 浏览器业务链路

通过真实浏览器文件选择、下载和签署界面完成：144×108 合成 PNG 上传、导入签署、96×72 缩放派生签署、登记确认、来源图、完整披露导出、隐藏 title 的部分披露导出、两个包分别在独立验证页重新上传、报告下载、撤回和退出。

同一个派生声明的完整包为 pass；部分包为 incomplete，仍分别标明图片/签名/上链/缩放复算通过；撤回后将原完整包再次上传，结果为 fail，具体为 anchor=withdrawn，密码学及编辑复算仍通过。完整和部分包另外经过编译 CLI 在线验证。撤回后的旧报告属于当时的历史观察，不能代表当前状态。

报告：browser-business.json 及 browser-business-full-report.json、browser-business-partial-report.json、browser-business-withdrawn-report.json。原图片、私钥、token、原证据 ZIP 不进默认发布包。可复用 CUA 辅助脚本为 scripts/browser-business.cua.mjs；它返回签署确认边界，操作者需核对真实弹窗，不能自动同意未知操作。没有执行机构审批、外部扩展钱包或限时授权提交。

## 外部钱包

补充 accountsChanged、chainChanged、disconnect 处理，移除旧 provider 监听并清理会话；签名前读取实际账户，EIP-712 签署前读取网络；签署期间连接变化会拒绝旧结果。provider 清理失败也不能保留签署身份；连接被拒绝或空账户不能回落到先前本机签署人。13 项钱包测试通过，其中新增 10 项。事件语义依据 [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193)。这仍不是实际钱包扩展或真实手机的验收。

## 持续运行

补充原子进度报告、失败/取消报告、状态检查、安全停止与脱离当前终端运行的控制。30 秒自检完成两轮真实业务，报告 soak-instrumentation-smoke.json。第一轮长测实际执行 2745 秒、183 轮、零业务错误，因改为固定构建快照主动取消，未计作 24 小时通过。

新启动器复制源码和服务端构建到独立快照，记录 SHA256 清单；后续工作区改动不会改变本次执行内容。node_modules 通过本机目录连接共享，测试完成前不要安装/更新依赖。`npm.cmd run soak:start` 启动、`soak:status` 查看实际进度，`soak:stop` 请求完成当前事务后停止。不会强杀未知 PID，不会把正在运行或已取消状态显示为通过。睡眠、关机或进程中断不能记作连续 24 小时运行。

首个快照漏复制 dist/web，完整启动页面等待在 30 秒超时，导致两轮后连接中断；失败记录已保留。已补齐前端快照，并要求验收器同时检查页面和后台就绪。修复后的 90 秒快照自检完成 6 轮零失败。随后又补充一小时会话到期之前的真实挑战重签、旧会话注销及新会话读取；默认每半小时执行，短测使用 15 秒间隔，实际完成6轮和3次续期。后续重启使用包含这些修复的固定快照。连续事务间隔超过120秒或时钟倒退将失败，不能把长时间挂起算成连续运行。

运行结果在 data/app/results/soak-24h-progress.json；最终报告为 soak-24h.json。只有最终完成且实际时长达到 86400 秒才验收。固定快照及运行库不进发布包。

## 故障和密钥

新增三个真实 Ganache 分支、连续两次回滚、复用签署人 nonce 的检查；旧分支状态、事件索引和完整重启后状态共 4 项通过，报告 reorg-branches.json。这不能替代恶意 QBFT 节点、非对称网络或异机灾备。

新增真实大图边界验收：18,033,955 字节的 6MP 合成 PNG 完成上传/加密/签名/上链/缩放/22,093,011 字节证据包导出与复算；20MP 图片接受、超 20MP 明确 413、20MiB+1 字节明确 413、拒绝后继续接受合法图片。修复超像素图片被归为普通处理错误的问题，返回 MEDIA_DIMENSION_LIMIT。Windows/Linux各5项通过，报告 media-boundaries.json / media-boundaries-linux.json；仍不能代表任意编码或最大并发吞吐。

新增只读固定版本 Vault KV v2 provider、26 项契约测试和本机真实 Vault 5 项验收。接入和边界详见 [Vault 说明](VAULT.md)。仍未实现云 KMS/Transit、Vault 数据重加密协调或跨主机 secret 切换。

## 尚需条件或后续实现

独立服务器/域名尚无；真实手机及扩展钱包未连接；生产 Vault/TLS/HA 未提供。四个许可原文缺口经官方发布元数据/固定提交再次查询仍未消除，详情为 LICENSE_SOURCES.json。C2PA、音视频、ZK、水印和可信时间戳仍是尚未实现的研究扩展，不将接口占位或自定义 sidecar 标成兼容通过。逐项当前状态见 COMPLETION_TRACKER.md。

当前 Windows/Linux 单元及回归各117项通过；Linux使用可信本机镜像及锁定依赖缓存离线构建，生产前端逐文件与Windows字节一致，记录linux-current-validation.json。它不代表已完成从远端基础镜像拉取的生产重建。
