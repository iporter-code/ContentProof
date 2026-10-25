process.on("message", (message) => {
  if (message === "crash") process.exit(9);
  if (message === "hang") return;
  process.send?.({ ok: true, result: message });
});
process.on("disconnect", () => process.exit(0));
