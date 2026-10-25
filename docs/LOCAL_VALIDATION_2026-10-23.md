# 第四轮：本机持续运行与故障恢复

本轮不依赖独立服务器，也不包含参赛材料。记录的是实际执行的检查及其边界，不能据此声称全部工程、P3 扩展或生产验收完成。

## 修复：重组后的登记重试

真实测试链执行回滚后，已确认任务会被读取接口标记为 orphaned；原重试接口仅处理 failed/confirmed，导致用户重新登记后任务仍停留在 orphaned。现已允许该状态重新排队，同时清除旧交易哈希、结果、租约及失败计数。更新条件保护 queued/submitted，避免重复点击把正在执行的租约重置。

test/job-recovery.test.ts 覆盖旧结果清理及活跃租约保护；scripts/test-faults.ts 使用新建隔离数据库和真实持久化测试链。六项检查包括实际回滚、重试/并发去重、拒绝竞争 API、已挖出交易的过期租约恢复、中断导出重建、索引回到规范区块。租约中断采用停机后注入持久化状态，不冒充任意时刻杀进程或断电覆盖。

## 持续运行与性能

10 分钟运行完成 40 次真实图片编辑、用户签名、EVM 写链、证据导出和链/图片独立验证，零失败；每轮另做两项并发分页。结束时图片 active/queued 均为零。

完整流程中位数约 5.62 秒，P95 约 6.15 秒。使用 256×192 合成图片，每 15 秒发起一轮，受正常接口限流约束；4 次/分钟是设定节奏，不是最大吞吐能力。API 进程 RSS 从约 54.8 MiB 到 70.1 MiB，峰值约 70.1 MiB；不含链和短命图片子进程，不能由此断言不存在内存泄漏。

工具支持 CP_SOAK_SECONDS=30..86400，默认 600；本轮未执行 24 小时测试。附加对照只对同一缩放操作比较进程内/独立进程各三次计时，输出字节一致；这属于小样本对照，不是完整基线/消融研究。

## 网络分区与编码矩阵

实际断开本项目 Docker 网络连接：3+1 仍确认新区块，2+1+1 停止确认，恢复连接后四个节点对同一已确认区块给出相同哈希。测试结束恢复配置地址并停止节点，不删卷。该检查不覆盖恶意验证者、非对称网络或独立机构的真实网络。

Windows/Linux 分别通过 18 个固定向量，各编辑重复两次。输入包括透明 PNG、普通 JPEG、渐进 JPEG 4:4:4、EXIF orientation=6、Display P3 ICC 和 CMYK JPEG；编辑为裁剪、缩放、旋转。导入保持原字节，编辑使用存储像素方向并转换 sRGB PNG；没有自动按 EXIF 旋转。这是明确的固定样本矩阵，不覆盖任意 ICC/编码器。

## 可复查的许可收集

Windows 现有清单包含 452 个 npm 组件；补收两个精确源码提交的原始 LICENSE，并保留六个安装文件中完整嵌入的原始许可。缺完整原文由 12 项降至 4 项：abstract-logging、acorn-import-assertions、async-eventemitter、mcl-wasm。声明或链接没有被当成完整文本。来源及 SHA-256 见 LICENSE_SOURCES.json 和 LICENSE_INVENTORY.json。

Linux 生产镜像另清点实际安装的 174 个 npm 包清单和 88 个系统包，收集 88 份系统版权文件及 Node/sharp/libvips 许可文件、原生库版本。Linux BOM 按实际文件生成，包括打包进来的额外文件，不推断依赖关系；与 Windows 的锁文件依赖清单范围不同。系统文件清单不是法律合规意见，源代码提供义务及分发方式仍需复核。

上游来源包括 [OpenZeppelin 5.2.0 原许可](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.2.0/LICENSE)、[sharp 官方安装与预编译说明](https://sharp.pixelplumbing.com/install/)，精确提交和文件摘要保留在机器可读清单中。

## 重跑

先执行 npm.cmd run build，确保 3081/8581、3082/8582 空闲，然后按需执行：

隔离验收工具新增了显式回环监听配置，以便在生产容器内执行；复用旧容器镜像前需要按运维说明重新构建，使其包含当前源码。

```powershell
npm.cmd run test:faults
npm.cmd run bench:local
npm.cmd run test:codecs
# 需已有本项目四节点配置及 Docker；会短暂改变其网络连接
npm.cmd run test:partition
```

每次故障/稳定性检查新建隔离目录，结束自动停服务；输出保存在 data/app/results。许可收集 npm.cmd run licenses，联网补收 npm.cmd run licenses:fetch；没有足够来源的条目保留缺口。镜像清点在生产容器中运行 node scripts/image-inventory.mjs，再取回 /tmp/contentproof-image-inventory。

## 仍待完成

全业务浏览器自动化、外部钱包/移动端全面兼容，24 小时和容量饱和测试、大文件/多机性能、完整研究基线、外部 QBFT 灾备、恶意验证者和非对称网络、云 KMS/Vault、真实跨机构部署及 P3 扩展仍未完成。浏览器限时授权提交按用户选择继续暂缓。
