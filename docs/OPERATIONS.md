# 运行、维护及验收

以下命令在项目根目录执行，PowerShell 使用 npm.cmd。环境变量不会自动从 .env 加载。参赛材料不在本次交付范围。

## 本机默认业务

```powershell
npm.cmd ci
npm.cmd run dev
```

默认网页 5173、API 3001、链 8545，数据在 data/app。创建/解锁浏览器身份、导出加密身份备份，再执行上传、编辑、签署和登记。浏览器来源改变、清缓存前先备份身份。服务端备份不能恢复遗失的用户签名私钥或口令。

编译部署不需要开发服务器：

```powershell
npm.cmd run build
npm.cmd run start:local
```

此时网页/API 同在 3001。supervisor 复用已有合约及链状态，首次才自动部署。Ctrl+C 按 API、节点顺序停止本次启动的子进程。npm start 仅启动编译 API，需要另行提供链及已有部署。

## 身份与机构

OPERATOR_ADDRESSES 配置一个或多个审核人公开钱包地址（逗号分隔），不是私钥。审核人须在浏览器持有对应管理身份，核对申请方提供的真实凭证后审批；不能自审。用户在机构页申请、邀请/接受成员、修改角色及共享/取消共享。机构名和凭证摘要本身不是第三方资质证明。

个人分享默认只读，显式 edit 才能派生；机构分享还受成员角色约束。素材原所有者控制再授权，声明签署者控制声明访问。分别撤销两者，已下载文件不能收回。关闭自助身份登记可设置 REGISTRATION_MODE=closed；它不等于完成机构准入。

## 离线备份与恢复

先停止 API 和本机链节点，确认没有其他容器/主机写同一目录。锁是同机保护，不能代替跨主机停机协调。备份目标必须是源目录外的新目录；口令至少 16 字符，在自己的终端设置，不要提交到源码。

```powershell
$env:DATA_DIR='./data/app'
$backupPassword=Read-Host '备份口令（至少16字符，仅在本机使用）' -AsSecureString
$env:CP_BACKUP_PASSWORD=[System.Net.NetworkCredential]::new('', $backupPassword).Password
npm.cmd run maintenance -- backup ./data/backups/snapshot-new
```

实际部署中可由受控环境注入口令。备份包含存储密钥和本机链状态，并整体认证加密；妥善保护口令。STORAGE_KEY_FILE 使用 64 位十六进制文件，维护 CLI 可读取并加密封装外置存储密钥。

恢复必须使用不存在的新目录，失败不覆盖原目录：

```powershell
$env:DATA_DIR='./data/restored-new'
npm.cmd run maintenance -- restore ./data/backups/snapshot-new
Remove-Item Env:CP_BACKUP_PASSWORD
npm.cmd run start:local
```

恢复后的本地 storage.key 是 32 字节二进制，默认程序直接读取。不要同时保留指向旧 secret 的 STORAGE_KEY/STORAGE_KEY_FILE 环境变量。外部 Besu/RPC 的链状态需另行备份，应用目录备份不包含远端节点数据。容器 named volume 的备份需先停容器并协调外置 secret；不要将正在运行的卷当作一致性快照。

内部文件密钥模式在停机后轮换，保留旧目录作为回滚。外置文件 secret 使用下节的 rotate-external，不可直接换掉旧密钥后启动：

```powershell
npm.cmd run maintenance -- rotate
npm.cmd run maintenance -- gc
# 核对 dry-run 候选后才执行实际孤儿清理
npm.cmd run maintenance -- gc --apply
```

轮换使旧导出失效，并重加密历史明文素材。重启后先检查旧图片、声明和链状态，再自行决定回滚副本的保留周期。不要自动删除唯一备份。

## 外置文件 secret 轮换与恢复

先停止 API、本机链及使用该目录的容器；不要在容器运行时操作卷。STORAGE_KEY_FILE 必须指向数据目录外可写的普通文件，内容为 64 位十六进制密钥。轮换程序读取当前密钥、重加密数据库及素材、生成下一密钥并协调替换，不能自行提前换成新值。不要同时设置旧的 STORAGE_KEY 环境变量。

```powershell
$env:DATA_DIR='./data/app'
$env:STORAGE_KEY_FILE='./private/storage-key'
npm.cmd run maintenance -- rotate-external
```

同级 data/app.key-rotation.json 保存恢复阶段及摘要，不含原始密钥；存在此日志时 API、链和普通维护拒绝启动。若轮换中断，保留全部 stage/rollback/secret 文件，选择继续或回滚：

```powershell
npm.cmd run maintenance -- recover-key commit
# 或恢复旧数据与旧密钥
npm.cmd run maintenance -- recover-key rollback
```

恢复命令根据日志核对匹配，拒绝中途由其他程序替换的未知密钥。保留返回的旧数据目录和 secretBackup 路径，私密存放；不要自动清除唯一可用副本。阶段切换模拟进程中断已验收，主机断电及任意存储系统事务语义未验收。此 provider 不覆盖云 KMS/Vault。

Docker 的 /run/secrets 是只读挂载，不能直接在容器内轮换该路径。维护必须在停机后对可写原 secret 与一致性数据副本协调执行；原子替换 secret 后需要重新创建容器以更新挂载的文件对象，仅 restart 可能仍使用旧挂载。不要把宿主机进程锁当作跨容器/跨主机协调。

## 授权、客户端核对和运行告警

声明详情的个人授权到期时间留空表示长期；接口 expiresAt 为毫秒时间戳或 null。到期立即影响读取、编辑、列表、统计及导出，后台清理只回收记录；独立机构授权不会随个人授权到期而失效。已下载文件不能收回。

上传前客户端计算 SHA-256 并核对回执；签署前检查下载文件的字节摘要和大小，再使用本地定义的 EIP-712 类型签署。未在浏览器重新执行图片编辑；实际复现由独立验证器完成。

图片任务子进程并发 2、队列 8，V8 堆上限 192 MB、20 秒超时；故障返回 MEDIA_WORKER_*（503）。这不是逐任务硬 RSS/CPU 限额，容器仍需资源预算。

“运行状态”每 5 秒读取指标及最近 50 条告警。连续 3 次异常激活，2 次正常恢复，涵盖登记 worker、索引、请求并发、图片排队和堆压力。记录入库并去重，OPERATOR_ADDRESSES 中的审核人可确认知悉；确认不会解决故障。本轮只做本机可见告警，没有第三方推送。

## Docker 编译版

```powershell
npm.cmd run deploy:init
docker compose -f deploy/compose.yml up -d --build --wait
```

网页为 3001，原始 secret 在 deploy/runtime/storage.key，独立 named volume 保存应用/本机链。容器不是临时内存链，重建镜像不更换密钥。停止使用 compose stop/down；不要加 -v。首次初始化只生成不存在的 secret。

如 Docker Hub 网络不可用，本轮使用官方 Node 的公共 ECR 镜像完成构建：

```powershell
docker compose -f deploy/compose.yml build --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
docker compose -f deploy/compose.yml up -d --no-build --wait
```

Docker Desktop 若发生 sailor-ingest.sock/engine.sock 启动错误，先读取 [工程更新](ENGINEERING_UPDATE_2026-10-23.md) 的上游说明。恢复脚本默认只检查，-Recover 仅在引擎不可用且目标目录只含已识别零字节套接字时保留改名运行目录；引擎正常会拒绝操作。它不是上游永久修复，不做 factory reset、镜像/卷清理或 WSL 注销。

```powershell
powershell -NoProfile -File scripts/repair-docker-runtime.ps1
powershell -NoProfile -File scripts/repair-docker-runtime.ps1 -Recover
```

## 四节点 Besu QBFT 与 RPC 备用源

需 Docker 可用，至少为四个节点预留各 1 GB 容器内存预算。构建固定校验的 Besu 镜像，初始化只执行一次：

```powershell
docker build -f deploy/Besu.Dockerfile -t ccf-besu:26.10.0 .
npm.cmd run chain:qbft -- init
npm.cmd run chain:qbft -- up
```

data/qbft-network 含私钥/准入配置，data/qbft-app/node.key 为独立已资助费用账户。不要分享、重建或打包这些文件。脚本拒绝覆盖现有/部分已生成的关键配置。四个 RPC 为 8575—8578，链 ID 31338。配置独立应用目录以避免与本机链合约混用：

```powershell
$env:DATA_DIR='./data/qbft-app'
$env:CHAIN_ID='31338'
$env:RPC_URL='http://127.0.0.1:8575'
$env:RPC_URLS='http://127.0.0.1:8576,http://127.0.0.1:8577,http://127.0.0.1:8578'
$env:CHAIN_MODE='external'
$env:EVM_VERSION='paris'
$env:PORT='3067'
npm.cmd run start:local
```

RPC 列表最多 5 个，只配置自己信任且属于同一网络的节点。外部模式不可达时拒绝启动，避免静默替代链。不同主机上的 TLS、节点密钥保管、备份、网络准入与运维责任需部署方另外落实。

以下故障检查会暂停/恢复本项目验证节点，先停止该应用的手动运行实例，避免端口 3067 冲突；使用独立测试数据：

```powershell
npm.cmd run test:qbft
npm.cmd run test:rpc-failover
npm.cmd run chain:qbft -- down
```

down 保留卷。测试覆盖同机进程停止和法定人数，不是完整恶意节点/跨机构对抗实验。

## 其他检查与交付

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:reliability
npm.cmd run bench:protocol
npm.cmd run test:media-vectors
npm.cmd run source:index
npm.cmd run release
```

test:reliability 自动创建独立目录/端口，真实停机备份、恢复、轮换并验证旧数据，结束后关闭服务。bench:protocol 仅测协议，链/媒体为替身。OpenAPI 覆盖 59 个操作的严格领域响应或明确二进制格式，运行时同样验证 JSON 输出。发布包含源码、编译产物和选定验收记录，排除数据、密钥、身份和本机路径，并附内部及外部 SHA-256。

## 第四轮本机验收工具

先 build，再执行 test:faults、bench:local、test:codecs；已有四节点配置时可执行 test:partition。持续测试默认 600 秒，可通过 CP_SOAK_SECONDS 改为 30..86400；本轮实际只运行 600 秒。隔离目录和专用端口、网络故障影响范围、许可清点方式及未覆盖场景见 [验收记录](LOCAL_VALIDATION_2026-10-23.md)。浏览器限时授权提交按用户选择暂缓。

## 容量与浏览器巡检

先 build，再运行 npm.cmd run test:capacity，使用独立 3084/8584 端口及新建数据目录。页面自动化脚本 browser-smoke.cua.mjs 在 CUA 浏览器运行时执行，详细步骤与覆盖边界见 [第五轮验收](LOCAL_VALIDATION_2026-10-24.md)。

## 第六轮补全工具

Vault KV v2只读固定版本接入见 [Vault说明](VAULT.md)。先build，再运行test:vault、test:reorg、test:media-boundaries，均为隔离合成数据。soak:start冻结当前源码和前后端构建并启动24小时验收，soak:status查看真实状态，soak:stop安全取消；测试结束前不要更新依赖。90秒快照/续期自检可运行node scripts/soak-control.mjs start --smoke，同样使用专用端口，不应与长测同时启动。保留已有运行历史后才可新启，禁止覆盖活动进程记录。

离线Linux验收可使用deploy/Validation.Dockerfile，VALIDATION_BASE必须是已存在并可信的本机项目镜像；该测试镜像使用缓存安装开发依赖，不是生产部署入口。线上基础镜像仓库不可用时不能把离线验收说成成功拉取了最新基础镜像。

## Vault数据轮换与Transit

prepare-vault/recover-vault/rotate-vault使用数据目录之外的可写版本引用文件，init-transit为全新目录创建封装密钥，rewrap-transit升级封装主密钥。需按不同角色配置Vault权限，停机重加密；详细配置和恢复边界见 [Vault说明](VAULT.md)。本轮Windows/Linux各12项真实验收见 [第七轮记录](KEY_ROTATION_COMPLETION_2026-10-24.md)。

soak:archive只归档已停止运行，保留原日志并记录中断；不会把多个运行累计成连续24小时。新的冻结快照同时携带前后端构建、API文档和验证配置。
