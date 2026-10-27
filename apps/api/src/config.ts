export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.HOST ?? '127.0.0.1';
  const rawPort = env.PORT ?? '4100';
  const port = Number(rawPort);
  if (!host.trim()) throw new Error('HOST must not be empty');
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return { host, port };
}
