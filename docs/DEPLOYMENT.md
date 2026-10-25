# 运行与部署

本机默认：Node22，npm ci后npm run dev，终端保持运行，网页127.0.0.1:5173，API3001，EVM8545。需要先后检查链、部署、API就绪、前端状态，doctor脚本可检查基本连通性。启动器不清空用户数据库。

依赖锁定在package-lock。合约由solc-js编译并用viem部署，默认ABI与地址写data/app/deployment.json；不要手工替换ABI或把陌生部署配置当作可信身份根。首次离线运行前必须完成npm ci及本机编译。

默认业务数据data/app，默认节点使用chain-db落盘，停止全部服务再重启已有合约与声明仍在。node.key为随机生成的节点费用账户；用户签名在浏览器完成。Ganache已归档，仅作本机参考节点。生产环境需配置受维护的外部RPC并重新验收；单机持久化不是跨机构共识。

备份需要在一致性停机状态下覆盖数据库、对象文件、storage.key、deployment.json和节点数据；缺存储密钥无法解密。浏览器身份备份需由用户另行导出。备份包含隐私，不能直接放入参赛源码包。完整自动备份/恢复及加密密钥轮换尚未实现。

编译运行：npm run build后启动node dist/server/scripts/persistent-chain.js；首次部署执行node dist/server/scripts/deploy.js（已有部署勿重复）；另开终端npm start，网页与API同在3001。无需运行Vite或tsx。完整配置及启动命令见../README.md。

DEMO_MODE默认false，只有显式true启用公共测试身份；演示目录data不与业务目录混用。外部服务要求STORAGE_KEY、可信Origin及明确REGISTRATION_MODE；真实组织审核、TLS运维和全资源隔离仍需建设。Dockerfile/Compose为历史研究配置，尚未对本轮业务节点实测，不能按生产可用交付。
