# 归档：剩余问题处理记录

<!-- archived-status-snapshot -->
> 已归档：只记录标题日期的验收与处理范围，文中的测试数量、运行中或未推送描述均为历史事实。当前有效状态统一见[CURRENT_STATUS](CURRENT_STATUS.md)。

本轮继续处理项目剩余问题。此前手机签署与最近声明已实机确认，本轮不将其重复计作新成果。

## 依赖和参考链

OpenZeppelin 从 5.2.0 固定更新至 5.4.0，保留现有 Shanghai 配置；真实链编译、登记与业务通过。此前 5.6.1 的 MCOPY 不兼容尝试未采用。solc 保持 0.8.38，其 tmp 通过定向 override 固定至 0.2.7。新 OpenZeppelin 的完整许可取自官方版本标签解析的不可变提交，并核对 Git blob，未使用通用条款替代准确来源。

本地生产扫描由 36 降至 33 项：5 critical、22 high、5 moderate、1 low。剩余全部位于 Ganache 及其嵌套组件，仍未消除。实际业务中观察了 487 个 CommonJS 文件；uws、ws、secp256k1 等确实被加载。没有观测到的文件也不能据此认定不可达，因为 Ganache 包含 webpack 内嵌副本，且采样不覆盖每个分支或 ESM。

尝试的 ws 定向 override 没有改变 Ganache shrinkwrap 内的 8.13.0，已移除无效配置，未把该告警记作关闭。参考链仅使用 HTTP RPC，已显式禁用未使用的 WebSocket 服务；真实握手拒绝及 HTTP RPC 继续可用已加入集成验收。这是减少暴露接口，不是修补所有旧库。

证据：data/remediation-2026-10-25/audit-final.json、dependency-risk.json、runtime-trace/、oz-source.json。完整许可原文缺口仍为原有 4 项。

## 长测机制

上一轮约 9.5 小时、2281 次流程的记录已保留到 data/app/results/soak-history，标记 interrupted/false。停止前没有业务错误，也没有最终退出报告；系统事件查询未取得足够证据，原因仍未知。

已修复的测试基础设施问题：

- 每次完整复制代码、编译产物和 node_modules，取消共享依赖目录链接；开始和结束核对文件清单、逐文件摘要与 Node 二进制摘要。新增、修改代码或依赖会使验收失败，不会静默接受。
- 增加独立 watchdog；测试进程非正常退出会形成失败记录。云端 systemd 在服务停止后补充终态；异常断电后再次查询也会识别中断。失败和取消均不计通过，不拼接两次运行冒充连续24小时。
- 增加墙钟与单调时钟偏差检查，保留最大流程间隔检查，避免系统时钟跳变误算时长。
- 新增独立云端测试账号、隔离端口和测试链；不读取生产 app.env、业务数据库或身份。测试服务限制 CPU 50%、内存600MiB、交换空间256MiB，优先级降低；生产服务不加入该测试服务组。

Windows 90秒自检已完成6次流程、3次会话续期，摘要核对通过。该短测的依赖快照早于本轮最后的WebSocket禁用修改；它验证冻结与退出机制，不代替最终版本24小时验收。最终版本在Ubuntu隔离服务中也完成6次流程、3次续期，服务正常退出、摘要核对通过。随后已启动完整24小时独立测试，unit为contentproof-soak-20261025T050104Z-1d89c5b0.service；截至本轮交付仍在运行，不能预先记作通过。长测不因本机窗口或SSH断开而结束。

启动和查询示例（需运维权限、官方固定安装工具及已校验源码ZIP）：

```text
bash deploy/cloud/soak-service.sh start /绝对路径/source.zip SHA256 90
bash deploy/cloud/soak-service.sh status
bash deploy/cloud/soak-service.sh start /绝对路径/source.zip SHA256 86400
bash deploy/cloud/soak-service.sh stop
```

stop 写入停止请求，让当前流程结束；不凭 PID 终止未知进程。测试快照和报告保留在 /var/lib/contentproof-tests/runs。启动下次测试只更新 latest.json，不删除上一次证据。

## 权限与回归

- 202项单元/回归通过，包括新增依赖快照修改检测及异常退出记录测试。
- 7组真实链集成通过，包含既有8项业务检查及新增WebSocket拒绝验证。
- 8组真实HTTP/EVM权限专项通过：禁止自审/越权审批、未批准机构禁止共享、邀请接受、owner/admin/editor/viewer边界、角色降级、成员移除、机构暂停、共享撤销、个人授权到期、已缓存草稿/导出/分页/统计动态收回、禁止阅读者再授权。
- 权限专项已接入Windows/Linux CI工作流。它是API与真实链验收，不冒充机构页面的完整浏览器验收；远端CI仍需真实仓库运行记录。

证据：data/remediation-2026-10-25/tests.json、data/fix-audit-2026-10-24/integration.json、data/app/results/permissions-real-chain.json。

## 尚需完成

持续24小时的真实通过结果；33项Ganache告警的进一步修复或兼容节点替代；4项许可准确原文；完整机构浏览器与真实钱包验收；远端CI；多主机共识/灾备及生产KMS/Vault。完整C2PA写入、音视频编辑、批量登记等扩展仍按原范围开放。

云端源码传输曾被自动审批拒绝，原因是缺少向具体服务器传输源码的明确确认。用户随后明确允许向47.108.145.159进行隔离测试并发布修复；仅此范围恢复执行，不扩展为其他目的地的授权。

## 发布

已在停机一致性加密备份后发布，并通过11项公网检查，原有图片/声明及HTTPS配置保留。本轮没有重新部署现有链上合约；新增部署使用兼容版本编译，历史部署仍按已保存ABI和字节码摘要检查。

- 运行版本：/opt/contentproof/releases/remediation-9c9c77d69d6a2da3。
- 源码包SHA-256：9c9c77d69d6a2da3160384283fdf0bebb5a54c1e01c87d5088624c41ccedcc7d。
- 加密备份：/var/backups/contentproof/20261025T050050Z。
- 回滚配置：/var/backups/contentproof/deploy-20261025T050118Z。
- Linux发布前通过历史图片复算、7组真实链集成、8组权限验收；发布后公网11项通过。

本地Git版本基线已建立，初始提交d6f1776，分支codex/project-baseline；运行数据和已知敏感材料经过排除检查。未推送到任何新服务，也没有把本地检查冒充远端CI通过。此次服务器发布以源包SHA-256及逐文件摘要固定，Git基线是在发布后补建，不追溯伪造构建时的提交记录。

验证报告位于data/remediation-2026-10-25。本轮源码传输确认只用于现有服务器的测试与修复发布，没有上传到其他服务。
