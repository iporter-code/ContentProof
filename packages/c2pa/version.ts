import nativeTools from "../../configs/native-tools.json" with { type: "json" };

// Shared by the verified executable, availability endpoint and report schema.
export const c2paToolConfig = nativeTools.c2patool;
export const C2PA_VERSION = c2paToolConfig.version;
export const C2PA_VERIFIER = `c2patool/${C2PA_VERSION}`;
