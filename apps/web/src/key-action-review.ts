import { isAddress } from "viem";

export type KeyAction = "authorize" | "retire" | "revoke";
export type RegisteredKey = {
  epoch: string;
  record: readonly [string, string, string, string];
};

export function reviewKeyAction(
  action: KeyAction,
  epoch: string,
  newSigner: string,
  keys: RegisteredKey[],
) {
  if (!/^[1-9]\d{0,20}$/.test(epoch)) throw Error("请输入有效的正整数世代编号");
  const registered = keys.find((key) => BigInt(key.epoch) === BigInt(epoch));
  const address = action === "authorize" ? newSigner : registered?.record[0];
  if (
    !address ||
    !isAddress(address, { strict: false }) ||
    /^0x0{40}$/i.test(address)
  )
    throw Error(
      action === "authorize"
        ? "请输入有效的新签名地址"
        : "未找到该世代的已登记签名地址，请核对世代编号后重试",
    );
  if (
    action === "authorize" &&
    registered &&
    !/^0x0{40}$/i.test(registered.record[0])
  )
    throw Error("该世代已经登记，请选择尚未使用的世代编号");
  const effects = {
    authorize: "授权后，新声明需使用此密钥签署；登录身份保持不变。",
    retire: "停用后，该世代不能签署新声明；此前有效的历史声明仍可核验。",
    revoke:
      "撤销后，该世代签署的历史声明将不再满足在线核验条件。此操作不可恢复。",
  };
  const verbs = { authorize: "授权", retire: "停用", revoke: "撤销" };
  return {
    request: Object.freeze({ action, epoch, signer: address }),
    message: `确认${verbs[action]}密钥世代 ${epoch}？${action === "authorize" ? "新签名地址" : "已登记签名地址"}：${address}。${effects[action]}`,
  };
}
