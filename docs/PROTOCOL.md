# 协议与验证语义

版本contentproof/1。实际字段以packages/protocol/index.ts中的Zod schema为准。文件摘要计算原字节，manifest外置，避免摘要循环。字段JCS规范化参考[RFC8785](https://www.rfc-editor.org/rfc/rfc8785)。

字段按path排序，叶子为SHA256(0x00 || JCS({domain,index,path,value,salt}))；父叶使用不同domain并绑定有序输入claimId、assetDigest、role与独立随机盐。中间节点SHA256(0x01 || left || right)，奇数复制末节点，空树采用固定域摘要。证明带index、leafCount和有序siblings，验证器校验形状、索引、重复及奇数复制。

core包含文件摘要、长度、MIME、两个根和数量、操作、引擎摘要、issuer、epoch、nonce和deadline。签名使用[EIP-712](https://eips.ethereum.org/EIPS/eip-712)，域绑定链与合约；claimId为最终签名摘要，不含signature。合约独立检查nonce和deadline，不能把EIP712本身当作重放防护。

导出字段承诺列表和公开字段证明；父节点每个槽位仍存在，隐藏槽位只保留承诺。公开列表会泄露字段/父数量。隐藏字段不会导出原文或盐。DAG遍历公开父关系，缺少公开manifest标记missing；合法隐藏标记withheld；签名、承诺、文件或复算错误标记fail。

报告七项分开：文件、签名、锚定、身份、披露、来源、复算。链不可访问是offline；隐藏或缺失使结果incomplete。节点引用/操作是签名声明，只有拥有全部输入和参数且引擎一致时才能复算图片。AI生成和初始素材来源默认declared-only。

ZIP索引含目标和条目列表。条目只允许bundle.json、manifests/0x<64hex>.json、media/0x<64hex>。验证器不落盘解压，限制总128MB、单条32MB、3000条，拒绝重复和危险路径。

本协议不是C2PA。C2PA原生Actions、Ingredients、Redaction、签名/证书、内嵌绑定详见[2.4规范](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html)。新增的[原生验证入口](C2PA.md)单独验证C2PA文件，不转换或冒充本协议证据包。工程候选贡献是披露感知报告、约束绑定及独立核验闭环，原创性仍待完整文献检索。
