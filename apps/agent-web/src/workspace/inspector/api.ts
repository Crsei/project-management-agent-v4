export function inspectUrl(path: string, params?: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
