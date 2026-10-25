# 原生 C2PA 验证

ContentProof新增独立的原生文件验证入口，调用官方 `contentauth/c2patool` 0.28.2，对实际文件中的内嵌凭证执行验证。它与 `contentproof/1` 证据包、钱包身份、编辑复算及链上锚定分开，不能相互冒充。

## 安装与使用

```sh
npm run setup:c2pa
npm run build
npm run verify -- verify-c2pa asset.png --output report.json
```

支持Windows x64和Linux x64。安装只写入工作区 `data/tools`，不修改系统PATH，不安装服务。配置文件 `configs/native-tools.json` 固定官方发布地址、发布提交、压缩包SHA256和可执行文件SHA256；启动验证时再次检查二进制。发布包不包含原生程序或官方附带的开发私钥。下载失败时，可以从配置中相同的官方地址手动下载，然后执行：

```sh
npm run setup:c2pa -- --archive path/to/official-archive.zip
```

Linux归档使用 `.tar.gz`，官方GNU二进制要求较新的系统库，启动日志包含GLIBC_2.38/GLIBC_2.39符号需求。默认Debian12/bookworm业务镜像的glibc2.36不能运行它，本轮在Debian13/trixie的glibc2.41中通过验收。仅安装成功不代表可运行，状态接口会实际启动 `--version` 检查并报告 `C2PA_RUNTIME_INCOMPATIBLE`。部署时使用实际验证通过的兼容环境并只读挂载验证器。传入归档仍必须符合固定哈希，不接受自编译或其他版本。无安装回执的已有目标目录不会被覆盖，管理员应先检查其内容并另行保留。

已登录用户也可在“独立验证”页面上传原生文件。接口为 `GET /v1/verify/c2pa/status` 和 `POST /v1/verify/c2pa`，请求和响应见生成的OpenAPI。上传不写入素材库，临时目录在成功或失败后清理。

## 信任策略与结果

默认没有受信任证书。文件的签名和绑定有效，也只能报告 `integrity=valid, trust=not-configured, outcome=incomplete`。文件携带的证书不会自动成为信任根。

管理员可设置 `CP_C2PA_TRUST_ANCHORS_FILE`，指向本地PEM格式CA证书集合，最多1MiB。每张证书必须具有CA标记；直接把签署者叶证书当CA会被拒绝。证书原字节SHA256进入报告的 `policySha256`，用于识别当时的本地策略。此策略由部署管理员负责维护，不代表已采用C2PA官方信任名单或完成机构资质认证。

只有原生验证器报告Trusted、主动清单的签名和格式特定文件绑定成功、显式CA策略存在且没有失败项时，才返回 `outcome=pass, trust=operator-trusted`。文件绑定/签名/证书撤销或断言格式失败返回fail；无法解析的文件拒绝验证。未知报告结构、未知原生状态、缺主动清单或缺签名/绑定证据不会得到通过结论。父素材新增失败也会进入结论。

所有结果限定为 `scope=embedded-offline`：不下载远程清单，不进行在线OCSP查询，不验证CAWG附加身份声明；分别标注 `revocation=online-not-checked` 和 `identityAssertions=not-checked`。凭证中已有的原生失败仍会导致失败。仅有远程引用或没有内嵌凭证时返回incomplete。签署者名称只是证书内容，不能解释为本系统钱包、作者本人或机构资质。

C2PA绑定遵循对应格式允许的排除区间，不能解释为签名覆盖每一个原始字节。报告额外提供整个上传文件的SHA256用于识别本次输入。通过凭证验证不证明画面或声音内容属实、版权归属或AI模型来源。

## 本机验收

```sh
npm run setup:c2pa-fixtures
npm run test:c2pa
```

前者下载固定Git blob和SHA256的官方SDK MP4测试素材，仅放入data，不进入发布包。PNG/JPEG和WAV由测试现场生成。测试使用原生工具内置开发证书，只在隔离测试进程中显式信任其测试CA；不会配置业务服务的信任策略，也不会建立生产签署服务。

实际验收涵盖无凭证、未配置信任、显式测试CA信任、PNG/JPEG/WAV/MP4、图片/音频/视频内容篡改、叶证书误配置、远程引用零请求、环境设置覆盖防护、大小边界、登录鉴权、编译接口及独立命令。结果记录在 `data/app/results/c2pa-native.json` 或 `c2pa-native-linux.json`。普通单元测试无需安装原生工具或下载素材。

## 资源和部署边界

单文件20MiB；仅接收内容头符合PNG/JPEG/WAV/MP4的输入。文件名由服务生成，客户端文件名不作为命令参数；启动原生进程不经过shell。私有工作目录、最小子进程环境、独立JSON设置、禁用网络白名单/远程清单/OCSP/重定向/身份解析，避免使用用户配置和目录旁的信任缓存。解压清单限制8MiB，单进程20秒，stdout与stderr合计4MiB，并发1、排队2；API与证据包验证共享入口并发保护。

这些是进程、输入和时间约束，不能替代操作系统内存/CPU隔离。生产环境仍应使用容器或系统权限隔离，并及时评估固定工具版本的安全更新；更新须重新核对归档和二进制哈希及验收。`CP_C2PA_INSTALL_DIR` 可指向部署时只读挂载的匹配安装目录，含provenance.json和binary子目录；信任PEM应另行只读挂载。默认生产镜像不自动下载验证器。

尚未覆盖：远程清单/原生外置sidecar输入、CAWG身份验证、在线吊销刷新、原生生产签署、完整C2PA合规认证、全部媒体编码组合及大型音视频编辑链。现有受控编辑和复算仍以PNG/JPEG为范围，WAV/MP4在此处仅完成原生凭证读取及绑定验证。

## 固定上游来源

- [c2patool 0.28.2官方发布](https://github.com/contentauth/c2patool/releases/tag/v0.28.2)
- [固定提交的CLI实现](https://github.com/contentauth/c2patool/blob/df3a52743e44795db7808a8f9055d66183c9690a/src/main.rs)
- [配套SDK 0.91.2源包](https://crates.io/crates/c2pa/0.91.2)，源包SHA256为 `6ee79d46ad4015f321f1e95730326b159918141e8cf3f3b0534fa5dc33012c2f`，与CLI的Cargo.lock一致。
- [原生格式规范](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html)

原生工具及其依赖的授权信息应随实际二进制分发另行保留；项目源码包不捆绑这些归档或二进制。
