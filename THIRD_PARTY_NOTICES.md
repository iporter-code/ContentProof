> 第四轮补充：完整许可原文缺口由 12 项降至 4 项；已收集 Linux 镜像的 88 个系统包版权文件、174 个实际 npm 包清单及原生版本。详见 docs/LOCAL_VALIDATION_2026-10-23.md 和 docs/IMAGE_INVENTORY.json。以下为较早说明，不能作为合规审查结论。

> 工程更新：已生成 docs/SBOM.cdx.json（452个生产npm组件）、docs/LICENSE_INVENTORY.json 和 docs/licenses。12个安装包未附独立许可文本，OS镜像与全部原生依赖法律审查仍待补核。以下组件说明保留供参考。

# 第三方组件与素材

依赖的精确版本和来源在package-lock.json。主要组件：React/React DOM、React Router、React Flow、Fastify及插件、Vite、TypeScript、Vitest、fast-check、viem、Hardhat、Ganache 7.9.2、OpenZeppelin Contracts 5.2.0、solc、sharp/libvips、canonicalize、fflate、yauzl和tsx。许可证以各node_modules包附带LICENSE及依赖链为准，发布商业产品前需生成完整SBOM和许可证汇总；此文不代替各项目原许可证。

应用源码、合约及测试为本项目编写。验收图片由sharp创建纯色像素，不含第三方人物或版权素材，不需要调用外部图片服务。名称“创作者A/编辑机构B/发布机构C”是历史演示测试标签。Hardhat公开测试账户只在显式demo模式使用；默认本机持久化链费用账户随机生成。Ganache项目已归档，当前仅作本机参考节点。

项目参考C2PA2.4、RFC8785、EIP712及OpenZeppelin官方文档，不声称这些技术或术语为项目原创。C2PA规范适用其自身许可/专利条款；本项目未宣称C2PA认证或完整兼容。
