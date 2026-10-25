import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
export const base = process.env.API_URL ?? "http://127.0.0.1:3001";
export async function request(
  path: string,
  token = "",
  body?: unknown,
  method?: string,
): Promise<any> {
  const r = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && !(body instanceof FormData)
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
  const json = await r.json();
  if (!r.ok) throw Error(`${r.status} ${json.error?.message}`);
  return json.data;
}
export const login = async (index: number) =>
  (await request("/v1/demo/login", "", { index })).token as string;
export async function upload(token: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)]), "fixture.png");
  return request("/v1/assets", token, form);
}
export async function signDraft(token: string, id: string) {
  await request(`/v1/drafts/${id}/prepare`, token, {});
  const sig = await request(`/v1/demo/sign/${id}`, token, {});
  const claim = await request(`/v1/drafts/${id}/signatures`, token, sig);
  const { jobId } = await request(`/v1/claims/${claim.id}/anchor`, token, {});
  for (let i = 0; i < 40; i++) {
    const job = await request(`/v1/jobs/${jobId}`, token);
    if (job.state === "confirmed") return claim.id as string;
    if (job.state === "failed") throw Error(job.error);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error("ANCHOR_TIMEOUT");
}
export async function bundle(
  token: string,
  target: string,
  hideFields: string[] = [],
  hideParents: number[] = [],
) {
  const r = await fetch(`${base}/v1/bundles`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ target, hideFields, hideParents }),
  });
  if (!r.ok) throw Error(await r.text());
  return new Uint8Array(await r.arrayBuffer());
}
export async function fixture(width = 512, height = 384, overlay = false) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: overlay ? "#d8ab64" : "#426959",
    },
  })
    .png()
    .toBuffer();
}
export async function seed() {
  const tokens = await Promise.all([1, 2, 3].map(login));
  const original = await upload(tokens[0], await fixture());
  const draft = await request("/v1/drafts/import", tokens[0], {
    assetDigest: original.digest,
    fields: {
      title: "校园活动视觉素材",
      "ai.prompt": "PRIVATE_DEMO_PROMPT",
      "source.location": "PRIVATE_DEMO_LOCATION",
    },
  });
  const root = await signDraft(tokens[0], draft.id);
  const identities = (await request("/v1/identities")).identities;
  for (const i of [1, 2])
    await request(`/v1/claims/${root}/grant`, tokens[0], {
      address: identities[i].address,
    });
  const crop = await request("/v1/drafts/transform", tokens[1], {
    parents: [root],
    operation: "crop",
    params: { left: 32, top: 24, width: 400, height: 300 },
    fields: { title: "编辑机构裁剪版本" },
  });
  const cropped = await signDraft(tokens[1], crop.id);
  await request(`/v1/claims/${cropped}/grant`, tokens[1], {
    address: identities[2].address,
  });
  const stamp = await upload(tokens[2], await fixture(80, 60, true));
  const stampDraft = await request("/v1/drafts/import", tokens[2], {
    assetDigest: stamp.digest,
    operation: "ai-declaration",
    fields: {
      title: "AI风格标记（演示声明）",
      "ai.prompt": "PRIVATE_DEMO_PROMPT",
    },
  });
  const stampId = await signDraft(tokens[2], stampDraft.id);
  const finalDraft = await request("/v1/drafts/transform", tokens[2], {
    parents: [cropped, stampId],
    operation: "compose",
    params: { left: 280, top: 200 },
    fields: { title: "校园活动最终发布稿" },
  });
  const final = await signDraft(tokens[2], finalDraft.id);
  mkdirSync("data/demo", { recursive: true });
  writeFileSync("data/demo/full.zip", await bundle(tokens[2], final));
  writeFileSync(
    "data/demo/private.zip",
    await bundle(tokens[2], final, ["ai.prompt", "source.location"], [1]),
  );
  const result = { root, cropped, stampId, final };
  writeFileSync("data/demo/ids.json", JSON.stringify(result, null, 2));
  return { ...result, tokens, identities };
}
