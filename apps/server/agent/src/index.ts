// Internal native helpers must run before loading the PM server or opening its stores.
if (process.argv[2] === "__managed-chatgpt-token") {
  const { runManagedChatGptTokenCli } = await import("../../../../vendor/t3code/apps/server/src/cli/managedChatGptToken.ts");
  await runManagedChatGptTokenCli(process.argv.slice(3));
} else if (process.argv[2] === "__claude-history") {
  const { runClaudeHistoryWorker } = await import("../../../../vendor/t3code/apps/server/src/claudeHistoryWorker.ts");
  const [method, sessionId, options] = process.argv.slice(3);
  await runClaudeHistoryWorker(method, sessionId, options);
} else {
  await import("./server.ts");
}
export {};
