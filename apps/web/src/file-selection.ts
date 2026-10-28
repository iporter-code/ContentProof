// Clear the native input before starting async work so choosing the same file
// again fires change even when the previous check failed or chain state changed.
export function consumeFileSelection(
  input: Pick<HTMLInputElement, "files" | "value">,
) {
  const file = input.files?.[0];
  input.value = "";
  return file;
}
