import { extractDocumentText } from "@pm/t3code-provider-server/provider/documentTextWorker";

// The original parser runs alone; this entry never loads PM services or the t3 CLI.
const [command, documentPath, extension] = process.argv.slice(2);
if (command !== "__document-text" || !documentPath || !extension) {
  throw new Error("Expected __document-text <path> <extension>.");
}
try {
  process.stdout.write(await extractDocumentText(documentPath, extension));
} catch (error) {
  if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
    throw error;
  }
  // Match the original CLI: rejected documents are permanent; OS failures are retryable.
  process.exitCode = 2;
}
