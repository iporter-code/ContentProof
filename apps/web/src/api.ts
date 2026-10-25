export const token = () => sessionStorage.getItem("cp-token") ?? "";
import { signTyped, signingAddress } from "./wallet";
import { requestConsent } from "./consent-store";
import {
  fileDigest,
  verifyFile,
  reviewPrepared,
  reviewedClaimId,
  type SigningIntent,
  boundedAsset,
} from "./integrity";
const intentKey = (id: string) =>
  `cp-signing-intent:${signingAddress()?.toLowerCase()}:${id}`;
export async function confirmSigningNetwork(
  network: { chainId: number; provenance: string },
  replace = false,
) {
  if (
    !Number.isSafeInteger(network.chainId) ||
    network.chainId < 1 ||
    !/^0x[0-9a-fA-F]{40}$/.test(network.provenance)
  )
    throw Error("登记网络暂不可用");
  const domain: SigningIntent["domain"] = {
    name: "ContentProof",
    version: "1",
    chainId: network.chainId,
    verifyingContract: network.provenance as `0x${string}`,
  };
  const pin = JSON.stringify(domain),
    existing = localStorage.getItem("cp-signing-domain");
  if (existing && existing !== pin && !replace)
    throw Error("登记网络已改变，请在身份页核对并重新确认登记网络");
  if (!existing || replace) {
    if (
      !(await requestConsent(
        `请与部署方核对登记网络：\n链：${domain.chainId}\n合约：${domain.verifyingContract}\n确认后将保存为此网站的签署网络。`,
      ))
    )
      throw Error("已取消网络确认");
    localStorage.setItem("cp-signing-domain", pin);
  }
  return domain;
}
export async function createSigningDraft(
  input: {
    operation: string;
    assetDigest?: string;
    fields: Record<string, unknown>;
    parents?: string[];
    params?: {
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      angle?: number;
    };
  },
  sources: { id?: string; digest: string; size: number; mediaType: string }[],
) {
  const body = structuredClone(input),
    issuer = signingAddress();
  if (!issuer) throw Error("请先解锁签名身份");
  const imported = ["import", "ai-declaration"].includes(body.operation);
  if (
    imported
      ? sources.length !== 1 || sources[0].digest !== body.assetDigest
      : sources.length !== body.parents?.length ||
        sources.some((s, i) => s.id !== body.parents![i])
  )
    throw Error("缺少本地素材记录，请重新选择");
  const [network, profile] = await Promise.all([
    api("/v1/chain/status"),
    api("/v1/profile"),
  ]);
  if (
    !Number.isSafeInteger(network.chainId) ||
    network.chainId < 1 ||
    !/^0x[0-9a-fA-F]{40}$/.test(network.provenance)
  )
    throw Error("登记网络暂不可用");
  if (profile.address.toLowerCase() !== issuer.toLowerCase())
    throw Error("登录身份与签署身份不一致");
  const domain = await confirmSigningNetwork(network);
  if (issuer.toLowerCase() !== signingAddress()?.toLowerCase())
    throw Error("签署身份已改变");
  const draft = await api(
    `/v1/drafts/${imported ? "import" : "transform"}`,
    body,
  );
  const meta = imported
    ? sources[0]
    : await api(`/v1/assets/${draft.assetDigest}`);
  if (imported && draft.assetDigest !== meta.digest)
    throw Error("草稿文件与所选素材不一致");
  const intent: SigningIntent = {
    issuer,
    keyEpoch: profile.profile?.epoch ?? "1",
    domain,
    operation: body.operation,
    assetDigest: meta.digest,
    mediaType: meta.mediaType,
    byteLength: meta.size,
    engineDigest: draft.engineDigest,
    fields: {
      ...body.fields,
      ...(body.params ? { "operation.params": body.params } : {}),
    },
    parents: imported
      ? []
      : sources.map((s, i) => ({
          claimId: s.id!,
          assetDigest: s.digest,
          role: `input-${i}`,
        })),
  };
  if (issuer.toLowerCase() !== signingAddress()?.toLowerCase())
    throw Error("签署身份已改变");
  sessionStorage.setItem(intentKey(draft.id), JSON.stringify(intent));
  sessionStorage.setItem("cp-pending-draft", draft.id);
  return draft;
}
export async function uploadVerified(file: File) {
  const digest = await fileDigest(file),
    form = new FormData();
  form.append("expectedDigest", digest);
  form.append("file", file);
  const asset = await api("/v1/assets", form);
  if (asset.digest !== digest || asset.size !== file.size)
    throw Error("上传回执与本地文件不一致，请勿签署");
  return asset;
}
export async function waitForJob(jobId: string) {
  for (let i = 0; i < 60; i++) {
    const job = await api(`/v1/jobs/${jobId}`);
    if (job.state === "confirmed") return job;
    if (["failed", "withdrawn", "orphaned"].includes(job.state))
      throw Error(job.error ?? job.state);
    await new Promise((r) => setTimeout(r, 750));
  }
  throw Error("任务尚未完成，可在声明详情继续查看");
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const requestToken = token();
  const response = await fetch(path, {
    signal: AbortSignal.timeout(30000),
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${requestToken}`,
      ...(body instanceof FormData
        ? {}
        : body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401 && token() === requestToken) {
      sessionStorage.removeItem("cp-token");
      window.dispatchEvent(new Event("cp-session-expired"));
    }
    const e = await response
      .json()
      .catch(() => ({ error: { message: `HTTP ${response.status}` } }));
    throw new Error(e.error?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()).data as T;
}
export async function downloadBundle(
  target: string,
  hideFields: string[] = [],
  hideParents: number[] = [],
  progress?: (job: any) => void,
  signal?: AbortSignal,
) {
  const input = { target, hideFields, hideParents };
  await api("/v1/exports/preview", input);
  const cacheKey = `cp-export:${target}`,
    serialized = JSON.stringify(input);
  let created: any;
  try {
    const old = JSON.parse(sessionStorage.getItem(cacheKey) ?? "null");
    if (old?.input === serialized) {
      const job = await api(`/v1/exports/${old.id}`);
      if (["queued", "running", "completed"].includes(job.state)) created = job;
    }
  } catch {}
  if (!created) {
    created = await api("/v1/exports", input);
    sessionStorage.setItem(
      cacheKey,
      JSON.stringify({ id: created.id, input: serialized }),
    );
  }
  progress?.(created);
  try {
    for (let i = 0; i < 120; i++) {
      if (signal?.aborted) throw Error("已取消导出");
      const job = await api(`/v1/exports/${created.id}`);
      progress?.(job);
      if (["failed", "cancelled", "expired"].includes(job.state)) {
        sessionStorage.removeItem(cacheKey);
        throw Error(job.error ?? job.state);
      }
      if (job.state === "completed") {
        const res = await fetch(`/v1/exports/${created.id}/content`, {
          headers: { Authorization: `Bearer ${token()}` },
          signal,
        });
        if (res.status === 401) {
          sessionStorage.removeItem("cp-token");
          window.dispatchEvent(new Event("cp-session-expired"));
        }
        if (!res.ok) throw Error((await res.json()).error.message);
        return res.blob();
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error(`导出仍在后台处理，任务ID：${created.id}`);
  } catch (error) {
    if (signal?.aborted) {
      await api(`/v1/exports/${created.id}/cancel`, {}).catch(() => {});
      sessionStorage.removeItem(cacheKey);
    }
    throw error;
  }
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function signAndAnchor(draftId: string): Promise<string> {
  const saved = sessionStorage.getItem(intentKey(draftId));
  if (!saved) throw Error("缺少本地签署草稿，请重新创建后签署");
  const intent: SigningIntent = JSON.parse(saved);
  if (intent.issuer.toLowerCase() !== signingAddress()?.toLowerCase())
    throw Error("签署身份已改变");
  sessionStorage.setItem("cp-pending-draft", draftId);
  const prepared = await api(`/v1/drafts/${draftId}/prepare`, {
    refresh: true,
  });
  const typedData = reviewPrepared(prepared, intent);
  const content = await fetch(
    `/v1/assets/${prepared.core.assetDigest}/content`,
    {
      headers: { Authorization: `Bearer ${token()}` },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!content.ok) throw Error("无法读取签署文件，已停止签署");
  const announcedSize = Number(content.headers.get("content-length") ?? "0");
  if (announcedSize > 20 * 1024 * 1024) throw Error("签署文件超过大小限制");
  await verifyFile(
    await boundedAsset(content, prepared.core.byteLength),
    prepared.core.assetDigest,
    prepared.core.byteLength,
  );
  if (
    !(await requestConsent(
      `确认签署此内容声明？\n操作：${intent.operation}\n文件：${intent.assetDigest}\n字段：${JSON.stringify(intent.fields)}\n有序父声明：${intent.parents.map((p) => p.claimId).join(", ") || "无"}\n签名者：${intent.issuer}\n链：${intent.domain.chainId}\n合约：${intent.domain.verifyingContract}`,
    ))
  )
    throw Error("已取消，草稿保留以便恢复");
  if (intent.issuer.toLowerCase() !== signingAddress()?.toLowerCase())
    throw Error("签署身份已改变");
  const signed = { signature: await signTyped(typedData) };
  const result = await api(`/v1/drafts/${draftId}/signatures`, signed);
  if (result.id !== reviewedClaimId(typedData))
    throw Error("签署回执与本地声明不一致");
  const { jobId } = await api(`/v1/claims/${result.id}/anchor`, {});
  await waitForJob(jobId);
  sessionStorage.removeItem("cp-pending-draft");
  sessionStorage.removeItem(intentKey(draftId));
  return result.id;
}
