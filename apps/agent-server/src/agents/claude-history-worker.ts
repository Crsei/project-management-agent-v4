import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { sanitizeErrorText } from "../providers/verify.ts";

// Separate process: the SDK reads CLAUDE_CONFIG_DIR at module initialization.
const [sessionId, directory, upToMessageId] = process.argv.slice(2);
try {
  if (!sessionId || !directory) throw new Error("Session and cwd are required.");
  const result = await forkSession(sessionId, {
    dir: directory,
    ...(upToMessageId ? { upToMessageId } : {}),
  });
  process.stdout.write(`${JSON.stringify({ sessionId: result.sessionId })}\n`);
} catch (error) {
  let message = error instanceof Error ? error.message : "Unknown SDK fork error.";
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 4 && /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key))
      message = message.split(value).join("[redacted]");
  }
  process.stderr.write(`Claude native fork failed: ${sanitizeErrorText(message)}\n`);
  process.exitCode = 1;
}
