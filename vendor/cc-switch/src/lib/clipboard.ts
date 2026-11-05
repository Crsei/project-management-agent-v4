/** Browser clipboard permissions are authoritative; never copy on the server. */
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard access is unavailable; copy the displayed text manually.");
  await navigator.clipboard.writeText(text);
}
