# 归档：依赖许可原文补充核查

<!-- archived-status-snapshot -->
> 已归档：只记录标题日期的验收与处理范围，文中的测试数量、运行中或未推送描述均为历史事实。当前有效状态统一见[CURRENT_STATUS](CURRENT_STATUS.md)。

日期：2026-10-25。本轮从13个安装项、11个独立名称/版本的缺口中，关闭6个安装项、5个名称/版本；仍有7个安装项、6个名称/版本未关闭。408个已安装生产npm组件的范围不变。候选材料不计入已完成。

## 已关闭

| 名称/版本 | 安装项数 | 原文及适用证据 |
| --- | --- | --- |
| @ethereumjs/trie@5.1.0 | 2 | 发布gitHead 850860614ee1324863acdb2d3ff4255b8dab4553的packages/trie/package.json与README明确声明MPL-2.0，名称/版本准确匹配；保存Mozilla制定方完整固定版本2.0正文 |
| @ethereumjs/blockchain@6.3.0 | 1 | 同一提交的packages/blockchain准确版本声明MPL-2.0；采用完整官方2.0正文 |
| @ethereumjs/trie@5.0.4 | 1 | 提交295e5a3caa69c226e8f8edfad4ea72a843bc0b4f中准确版本声明MPL-2.0；采用完整官方2.0正文 |
| ethereumjs-util@4.5.1 | 1 | 提交860beb74e2c5444bbc0de0607f189e8d53d0a2f6的package.json及README声明MPL-2.0；采用完整官方2.0正文 |
| bs58@4.0.1 | 1 | 官方补加LICENSE的提交ec21ace130d0c08cc317448952b679ec1b93f17d，与发布提交ba80a23f74efc055577d7040ef32e1ae765d6702的package.json、唯一交付运行源码index.js均为相同Git blob；已安装源码也匹配。保留原始2018 cryptocoinjs版权及完整MIT正文，不改写年份 |

MPL材料是制定方固定版本正文及准确包版本的适用声明，不声称该文件原本存在于这些npm包。原文见[Mozilla-MPL-2.0.txt](licenses/upstream/Mozilla-MPL-2.0.txt)和[bs58@4.0.1-LICENSE](licenses/upstream/bs58@4.0.1-LICENSE)。来源类型及SHA-256在[LICENSE_SOURCES.json](LICENSE_SOURCES.json)，版本声明与Git blob在licenses/evidence/。

## 尚未关闭

| 名称/版本 | 安装项数 | 补充证据与剩余条件 |
| --- | --- | --- |
| mcl-wasm@0.7.9、0.9.0 | 3 | 精确版本声明BSD-3-Clause；固定原生mcl子模块a4fe1155c34cbbd7742cc1313c018f71418d9a81、45f95ec7b72825f3f3e680cc48728ebc3ac698ff的完整COPYRIGHT已按Git blob核实并原样保存，含日文正文。但尚不能确认该子组件通知同时覆盖全部包装层及生成代码 |
| abstract-logging@2.0.1 | 1 | 已保存准确README链接的完整作者许可页快照，并核实2014年作者网站映射，版权人为James Sumners。页面年份动态生成，尚未确认2.0.1应随附的历史通知；未生成或推测旧年份 |
| eth-sig-util@2.5.3 | 1 | 版本明确声明ISC；已保存官方ad73314c5a88ace89a15db8a657f9141b660d573后来补加的完整2020 MetaMask ISC原文。该提交index.ts与2.5.3不同，需确认旧版本适用范围，不能套用bs58同源码证明 |
| semaphore@1.1.0 | 1 | 准确提交README及bower.json声明MIT，bower.json有作者Andreas Brekken；package.json缺license字段，原扫描为UNKNOWN。未取得完整包专属通知，不能凭作者名编造版权行 |
| tmp-promise@3.0.2 | 1 | 准确提交package.json声明MIT及作者Benjamin Gruenbaum and Collaborators。准确提交和当前官方树未找到完整通知；底层tmp或其他作者项目的许可不能替代 |

完整候选材料在licenses/candidates/，不加入组件texts。历史作者映射单独保存为证据。[维护者询证草稿](LICENSE_MAINTAINER_REQUESTS_2026-10-25.md)已准备，尚未发送。用户已明确选择暂不联系维护者、保留未完成项。收到维护者确认或实施合适的依赖替换后，才能关闭相应余项。

## 校验与交付

- `node scripts/licenses.mjs`输出408个组件、7个安装项缺口。
- `node scripts/verify-notices.mjs`核对原文摘要、适用声明、Git blob、候选文件、缺口一致性及90份镜像通知摘要。候选与已接受来源不能同名同版本同时计数。
- 采集脚本保留人工证据和候选记录，新增COPYRIGHT识别及Git blob验证。GitHub API限流后未将失败请求当作内容不存在。
- 原交付工具的docs/范围会包含这些材料；另生成单独的许可资料ZIP与逐文件SHA-256供复核，路径见本地data/license-completion-2026-10-25/delivery/。
- 未升级、移除或替换依赖，未修改业务代码、重启服务或干扰长测，低危依赖迁移仍暂缓。

本轮专项5项通过：完整复制集校验、证据内容变动拒绝、候选冒充完成拒绝、隐藏缺口拒绝、ZIP解包后逐文件摘要与原件一致。材料ZIP包含758个条目，约1.23 MB；报告在data/license-completion-2026-10-25/validation.json。三份修改脚本语法及格式检查通过，未将之前211项业务回归冒称本轮重新执行。

完整正文采集和适用证据不代表全部分发义务已完成审查。MPL源码获取方式、版权通知保留等仍应结合实际交付形式复核。旧文档的13/11、4项等是历史轮次数字，当前以本文及机器清单为准。
