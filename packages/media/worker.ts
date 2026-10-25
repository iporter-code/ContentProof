import { inspect, execute } from "./index.js";
let used = false;
process.once("message", async (input: any) => {
  if (used) return;
  used = true;
  try {
    let result;
    if (input?.method === "inspect") result = await inspect(input.bytes);
    else if (input?.method === "execute")
      result = await execute(input.operation, input.inputs, input.params);
    else throw Error("INVALID_MEDIA_JOB");
    process.send?.({ ok: true, result });
  } catch (error) {
    process.send?.({
      ok: false,
      error:
        error instanceof Error && /^[A-Z_]{3,80}$/.test(error.message)
          ? error.message
          : "MEDIA_PROCESSING_FAILED",
    });
  }
});
process.on("disconnect", () => process.exit(0));
