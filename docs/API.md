# API使用说明

根地址http://127.0.0.1:3001。JSON成功返回{data}，错误返回{error:{code,message},requestId}。认证使用Authorization: Bearer <token>；会话有效一小时。以下路径除health、chain/status、identities、auth及demo/login之外需要认证。

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | /health/live、/health/ready | 存活/依赖健康；链离线ready返回503 |
| GET | /v1/identities | 已登记身份及demoMode；名称为用户自述 |
| POST | /v1/demo/login | {index:1..3}；仅显式DEMO_MODE=true |
| POST | /v1/auth/challenge | {address}，返回id/message/expires |
| POST | /v1/auth/verify | {id,signature}，挑战只能使用一次 |
| POST | /v1/auth/logout | 删除当前会话 |
| GET/POST | /v1/profile | 查询当前身份；{name}登记身份，受REGISTRATION_MODE约束 |
| GET | /v1/keys | 查询当前身份的签名密钥epoch |
| POST | /v1/keys/challenge | {action:authorize/retire/revoke,epoch,signer?}生成管理行动挑战 |
| POST | /v1/keys/action | {id,signature}；管理身份签署对应挑战 |
| GET | /v1/audit | 当前用户的操作审计 |
| GET | /v1/system/health | 当前服务worker/indexer/链依赖状态 |
| POST | /v1/assets | 单文件multipart上传 |
| GET | /v1/assets | 组织授权素材，最多200项 |
| GET | /v1/assets/:digest、/content | 元数据或二进制，需要ACL |
| POST | /v1/assets/:digest/grant | {address}，授权另一身份 |
| POST | /v1/assets/:digest/revoke | {address}，原owner撤销另一身份读取权限 |
| POST | /v1/drafts/import | {assetDigest,operation?,fields?} |
| POST | /v1/drafts/transform | {parents,operation,params,fields?} |
| PATCH | /v1/drafts/:id | {revision,fields}，仅未prepare草稿 |
| POST | /v1/drafts/:id/prepare | {refresh?,keyEpoch?}，固化待签名core和typedData；refresh显式更新待签版本 |
| POST | /v1/drafts/:id/signatures | {signature}，保存前核对授权密钥 |
| POST | /v1/demo/sign/:id | 本机测试身份签名，生产禁用 |
| GET | /v1/claims、/v1/claims/:id | 列表/详情，ACL约束 |
| GET | /v1/claims/:id/graph | 有限图遍历 |
| POST | /v1/claims/:id/grant | {address}，由原issuer授权 |
| POST | /v1/claims/:id/revoke | {address}，由原issuer撤销访问 |
| POST | /v1/claims/:id/anchor | 持久化幂等登记任务，返回jobId |
| POST | /v1/claims/:id/withdraw | {deadline,signature}，issuer签署EIP712 Withdrawal；演示模式兼容测试签名 |
| GET | /v1/jobs/:id | 仅任务owner可读 |
| POST | /v1/bundles | {target,hideFields?,hideParents?}，直接返回ZIP |
| POST | /v1/verify | 单文件multipart ZIP，返回分项报告 |
| GET | /v1/chain/status | 部署地址、高度、索引checkpoint |

字段值应当是JSON，最多120个用户字段；最终协议限制128叶，父最多8。API当前受控编辑输入最多2。裁剪params={left,top,width,height}；缩放={width,height}；旋转={angle:0/90/180/270}；合成={left,top}。字段名operation.params由系统覆盖为真实执行参数。

锚定任务状态queued/submitted/confirmed/failed/orphaned。失败后再次anchor可重试；已withdrawn的声明拒绝重试。nonce冲突需refresh重新准备并由用户签署，旧签名不会改变。所有已签名字段不能原地修改。API错误只返回稳定短信息，不输出私钥/盐/完整堆栈。

登录挑战只能用于auth/verify，密钥管理挑战只能用于keys/action。私钥、解锁口令和浏览器加密身份备份不提交到API。完整严格OpenAPI及游标分页仍未实现，当前说明不替代输入schema。
