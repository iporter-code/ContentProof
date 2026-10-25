process.on("message", (message) => {
  if (message === "environment") {
    process.send?.({ ok: true, result: Object.keys(process.env) });
    return;
  }
  if (message === "crash") process.exit(9);
  if (message === "hang") return;
  process.send?.({ ok: true, result: message });
});
process.on("disconnect", () => process.exit(0));
