# Vault 接入、数据密钥轮换与信封加密

支持 KV v2 的只读密钥读取，接入 supervisor、直接 API、合约部署和停机备份。每个 secret 的数据字段必须为 `key`，值为 32 字节十六进制；存储密钥可不带 0x，费用账户密钥规范化为带 0x。费用账户仍须在目标链上获得所需余额和准入。

配置示例（不是凭据，环境文件不会自动加载）：

```text
VAULT_ADDR=https://vault.example.org
VAULT_TOKEN_FILE=/run/secrets/contentproof_vault_token
VAULT_KV_MOUNT=secret
STORAGE_KEY_VAULT_PATH=contentproof/storage
STORAGE_KEY_VAULT_VERSION=1
RELAYER_PRIVATE_KEY_VAULT_PATH=contentproof/relayer
RELAYER_PRIVATE_KEY_VAULT_VERSION=1
```

可选 VAULT_NAMESPACE。每种密钥只能选择环境变量、文件、Vault 中的一种；固定版本为必填项，不能使用 latest。提供 Vault Agent 写入的 token 文件，不在配置、日志或发布包中放 token。token 在应用每次启动/备份时读取；应用不管理登录、续租或创建新 secret。上层负责续租，失效后必须先恢复凭据再重启。

应用策略仅需对应 secret 路径的 `read`：

```hcl
path "secret/data/contentproof/storage" { capabilities = ["read"] }
path "secret/data/contentproof/relayer" { capabilities = ["read"] }
```

远端必须 HTTPS，证书使用 Node 信任链；私有 CA 可通过 NODE_EXTRA_CA_CERTS 配置。仅 127.0.0.1 / ::1 测试服务允许 HTTP。禁止重定向；请求 10 秒超时、返回体最多 64KiB；校验返回版本及删除/销毁状态。鉴权失败、网络断开、版本不符或无效密钥都会停止启动，不生成替代密钥。错误不回显服务端正文或 token。

应用启动读取数据密钥后保留在进程内存中，并供已有加密代码使用。启动器将已解析的密钥传给它创建的服务进程；继承的 provider selector 会清除，子进程不会重复访问 Vault。使用该模式仍须保护主机和进程环境；它不提供硬件 HSM 隔离。

Vault 发布 v2 不会自动改变固定 v1。更改环境变量版本并不等于完成数据重加密。`rotate-external` 只支持文件 provider；KV v2 的重加密使用下面的版本引用文件及专用命令。保留有效旧版本，Vault 的版本保留策略也须覆盖仍在使用的旧密钥。

## KV v2 数据密钥轮换

选择 `STORAGE_KEY_VAULT_REF_FILE`，同时清除 STORAGE_KEY、STORAGE_KEY_FILE、STORAGE_KEY_VAULT_PATH、STORAGE_KEY_VAULT_VERSION。引用文件放在数据目录之外，其内容是非明文密钥的元数据：

```json
{"version":1,"path":"contentproof/storage","keyVersion":1}
```

应用通过该文件读取确切版本。引用文件仍属于需要保护的配置，更新它会改变应用使用的密钥。禁止软链接/目录连接参与轮换；可写的普通文件适合此流程，Kubernetes 只读 secret 挂载需要另行部署协调。

先由 Vault 管理者在同一个 secret 路径发布不同的新密钥版本，再停止应用和本机链。维护 token 只需读取新旧版本，不需写入 Vault。使用与启动一致的 VAULT_ADDR、mount、namespace 和 STORAGE_KEY_VAULT_REF_FILE：

```powershell
npm.cmd run maintenance -- prepare-vault 2
npm.cmd run maintenance -- recover-vault commit
```

生产安装可用 `node dist/server/scripts/maintenance.js` 执行同样参数。`rotate-vault 2` 连续完成准备和提交。中断后根据实际需要执行 `recover-vault commit` 或 `recover-vault rollback`，不要依次执行两种恢复动作。

准备阶段复制并重加密图片、声明、草稿和导出输入，失效旧导出，记录阶段日志；此时原目录与版本引用不变。提交发布新数据和版本引用；回滚保留放弃的新副本并恢复旧数据/旧版本。日志存在时启动器、API、链和普通维护均拒绝启动，直到恢复检查通过。日志、引用备份只含版本和摘要，不含密钥或 token；原数据回滚副本继续保留。

恢复核对源目录、数据密钥摘要、版本引用及 Vault 配置，拒绝未知第三版本或外部改写。提交需要新旧版本都可读；回滚只依赖旧版本，因此新版本已不可读时仍能恢复旧数据。不要在恢复完毕和备份确认之前销毁旧版本。这是单机目录/引用协调，不是跨主机事务或任意断电下的文件系统持久化保证。

## Transit 信封加密

此模式使用 Vault 的主密钥封装 256 位数据密钥，本地文件只保存封装密文。应用启动调用 decrypt，数据密钥仍会进入应用进程内存；程序不导出 Vault 主密钥。当前支持独立、非 derived 的 aes256-gcm96 主密钥。

先由管理员启用 Transit 并创建主密钥。初始化 token 需要读取该主密钥的元数据和使用 datakey/wrapped；该操作不返回明文数据密钥。为全新的数据目录生成封装文件：

```text
VAULT_ADDR=https://vault.example.org
VAULT_TOKEN_FILE=/run/secrets/provision_token
VAULT_TRANSIT_MOUNT=transit
VAULT_TRANSIT_KEY=contentproof-storage
DATA_DIR=./data/new-instance
```

```powershell
npm.cmd run maintenance -- init-transit ./deploy/runtime/storage.envelope.json
```

输出文件必须尚不存在。已有数据库或存储密钥标记的目录拒绝初始化。随后选择 `STORAGE_KEY_VAULT_TRANSIT_FILE` 指向该文件，清除其他存储密钥 selector，VAULT_TOKEN_FILE 改为应用 token。应用 token 只需：

```hcl
path "transit/decrypt/contentproof-storage" { capabilities = ["update"] }
```

本机引用/封装文件宜放在 deploy/runtime，凭据由外部 secret 目录提供。deploy/runtime 已排除版本管理、镜像上下文和发布包；发布还会拒绝收集已配置的凭据/引用路径及其备份，发现已配置明文密钥/token 会停止打包。

应用校验服务地址/namespace 绑定、封装格式以及返回的数据密钥恰好为 32 字节；失败不会生成替代密钥。

主密钥升级由 Vault 管理员执行。维护 token 另需对应 `transit/rewrap/contentproof-storage` 的 update 权限及 decrypt 权限，然后运行：

```powershell
npm.cmd run maintenance -- rewrap-transit
```

维护命令校验主密钥版本确实增加，并核验新旧封装解密为相同数据密钥，保留旧封装备份后原子更新文件。图片密文不变。没有新的主密钥版本、数据密钥变化或封装文件被外部修改时拒绝发布。此操作升级的是封装主密钥，与 KV v2 的数据重加密属于不同操作；当前没有提供任意 provider 之间的自动数据迁移。

停机备份会读取固定密钥并将其放入口令加密备份，恢复到新目录会恢复 storage.key。恢复目录属于持有数据解密能力的秘密材料，应按密钥保管；连接原 Vault 时版本必须仍与存储标记匹配。应用运行期间禁止备份/重加密，维护互斥会拒绝操作。

## 实际本机验收

`npm.cmd run test:vault` 使用 CP_VAULT_BINARY 指向官方、校验过摘要的 Vault。默认本机测试路径为 data/tools/vault-2.2.1/binary/vault.exe；该路径下的工具不随发布包分发。脚本仅开启回环地址上的内存 dev Vault，生成合成密钥和短期只读 token，丢弃会包含 dev 凭据的输出；测试结束关闭其专用服务。它不更改系统服务。

2026-10-24：官方 Vault 2.2.1 的 Windows/Linux 各 12 项实际检查通过，涵盖 KV v2、数据重加密、注入的发布中断恢复、编译维护命令、备份恢复、Transit 封装、实际主密钥升级、权限拒绝及篡改拒绝。另有 26 项读取契约、15 项轮换恢复、13 项 Transit 及 3 项恢复目录发布保护回归。报告为 data/app/results/vault-local.json 和 vault-local-linux.json。

实现依据：[官方 KV v2 API](https://developer.hashicorp.com/vault/api-docs/secret/kv/kv-v2)、[官方 Transit API](https://developer.hashicorp.com/vault/api-docs/secret/transit)。二进制来源与摘要见测试机 data/tools 下各平台 provenance.json；官方 [发布目录](https://releases.hashicorp.com/vault/2.2.1/)。未验收生产 Vault 的 TLS/HA、真实云 KMS、跨主机凭据协调及 HSM。
