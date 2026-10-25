# 异机恢复与生产密钥部署准备

当前只有一台云服务器。本目录是待接入外部资源的部署材料，不是异机恢复或生产Vault已验收的证明。不要把测试Vault、同机目录恢复或多个同机容器记作独立主机验收。浏览器用户私钥仍由用户保管。

## 异机恢复

在原服务器，针对已成功完成的加密备份创建传输核对计划，不解密或输出其中内容：

```text
node dist/server/scripts/deployment-readiness.js prepare-recovery /受控路径/完成的备份目录 /受控路径/新的恢复计划.json
```

计划只含原主机标识摘要、创建时间及加密文件的大小/SHA256。必须通过已核验主机身份的SSH等受控通道，与加密备份一起传往明确授权的第二台机器；恢复口令通过独立受保护渠道保管。当前未配置目标、没有外传生产备份。

第二台机器先安装匹配版本的运行时、应用及历史引擎。恢复口令写入操作者可读的0600文件，不写命令行、日志或聊天。在全新目录执行：

```text
node dist/server/scripts/deployment-readiness.js restore-recovery /受控路径/恢复计划.json /受控路径/备份目录 /全新数据目录 /受控路径/口令文件 /受控路径/新的恢复报告.json
```

工具拒绝同主机标识、已有目标、非规则/额外文件和传输摘要不符；随后调用AES-GCM认证恢复、逐文件明文摘要与SQLite完整性校验。主机标识与计划需来自可信OS/原服务器，不能作为硬件远程证明。

恢复报告仅证明这些步骤。还需启动独立API和链，核对历史区块及合约、原图片与旧声明，实际完成新签署/导出/复算/重启，并记录恢复时长和恢复到的备份时间点。Vault托管时也要独立恢复Vault及其授权，避免应用和密钥服务共同依赖原机。不得覆盖或删除原服务器数据来模拟事故。

## 生产Vault

模板位于vault/。外部服务地址、CA/证书、持久化存储、操作者、审计保存、恢复份额保管及备份职责必须先落实。高可用还需要跨独立故障域的Raft节点和实际故障切换验收；本仓库不自动创建这些外部资源，也不在应用机启动生产Vault。

1. 在独立Vault环境替换server.hcl.example的占位地址/身份，配置真实证书、持久化Raft、主机内存/交换空间控制和至少一个可写审计设备；初始化/解封份额由不同操作者受控保管，应用不得使用root token。
2. KV方案将**现有**存储密钥和现有费用账户私钥通过受保护的运维流程写到各自固定版本。先比较密钥标识和费用账户公开地址。不能生成新密钥替换旧密钥，否则旧数据无法读取或链费用账户不匹配。
3. 应用采用application-kv-policy.hcl，只有目标路径read权限。另建维护身份执行写入/轮换。AppRole限制CIDR、SecretID用途/期限，Agent续期并生成本机token文件。启动前由运维创建应用账号所属的0700目录 `/run/contentproof-vault/bootstrap` 并以0600安全投递短期SecretID；该路径允许Agent消费后删除，配置目录保持只读。重新认证需要新的安全引导，重启后也需重新准备bootstrap目录和SecretID。长期无人值守应配置适合基础设施的工作负载身份。
4. 切换前备份，移除app.env中的冲突FILE/raw provider，使用app.env.example并固定准确版本。私有CA通过Node启动时的NODE_EXTRA_CA_CERTS加载，不能关闭证书校验。
5. 在应用身份和拟采用环境下执行 `node dist/server/scripts/deployment-readiness.js vault-kv /受控路径/新的预检报告.json`。预检检查实际TLS、非root且可续期的有限期token、目标密钥路径read且不能写的权限；不读取/输出密钥。它不覆盖所有策略路径，也不等于HA或实际切换通过。
6. 分别验收凭据到期/续期、403、网络故障启动拒绝、备份恢复、存储轮换及中断回滚，最后再切换。当前运行的应用可能已持有解密后的密钥，不能宣称断开Vault就立即停止其所有业务。

Transit是替代方案，不能与同一个密钥的KV/文件provider混用。application-transit-policy.hcl仅提供指定KEK的decrypt/rewrap权限，KEK管理归维护人员；数据密钥仍会进入应用内存。本项目已有新目录初始化和rewrap命令，现有数据迁移需单独受控设计，不能直接在生产目录执行init-transit。真正的私钥永不进入应用内存还需远程签名适配。

官方部署基线：[Vault production hardening](https://developer.hashicorp.com/vault/docs/concepts/production-hardening)、[Raft integrated storage](https://developer.hashicorp.com/vault/docs/internals/integrated-storage)。云KMS尚需其provider适配，不应把Vault接口当作任意云KMS已完成接入。
