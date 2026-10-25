# 相关工作初步对照

| 方案/标准 | 已有能力 | 本项目与其关系 |
|---|---|---|
| C2PA2.4 | 内容绑定、来源素材、动作、签名、删减、信任与验证规则 | 本项目使用自定义外置协议；不具备其证书生态、格式嵌入和完整兼容 |
| RFC8785 | JSON规范化便于可重复哈希/签名 | 直接采用成熟实现并增加输入边界检查，不声称新规范化算法 |
| EIP712 | 类型化结构签名与域分离 | 直接采用；nonce/deadline由本项目合约显式提供 |
| 单次哈希登记 | 判断精确文件字节是否匹配 | 作为B0；不提供编辑图及披露语义 |
| 签名日志 | 声明来源和完整性 | 作为B1；单个日志管理员的状态与多方链状态信任假设不同 |
| 全量披露同协议 | 检查全部已提供字段及来源 | B2隔离披露代价；与部分披露工作量不同 |

参考：[C2PA](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html)、[JCS](https://www.rfc-editor.org/rfc/rfc8785)、[EIP712](https://eips.ethereum.org/EIPS/eip-712)、[OpenZeppelin](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography)。

这不是完整的学术查新报告。对可删减签名、DAG覆盖及隐私来源图的论文检索还需扩大；禁止由此表推断学术首创性。
