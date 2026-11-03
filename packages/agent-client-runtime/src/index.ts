export * from "./providers.ts";
export * from "./mcp-apps.ts";
export * from "./provider-skills.ts";

// Derive fetch types instead of naming DOM-only aliases, so emitted declarations
// also work in Node consumers whose TypeScript lib does not include DOM.
type RequestInput = Parameters<typeof globalThis.fetch>[0];
type RequestHeaders = NonNullable<RequestInit["headers"]>;

export type WorkspaceClientOptions = {
  /** The trusted HTTP(S) service URL. Omit for root-relative, same-origin HTTP requests. */
  baseUrl?: string | URL;
  /** Optional same-origin mount prefix (for example /agent), applied exactly once. */
  basePath?: string;
  fetch?: typeof globalThis.fetch;
  /** Read credentials at request time; the client never persists them. */
  getHeaders?: () => RequestHeaders | Promise<RequestHeaders>;
};

export type WorkspaceClient = {
  url: (path: string | URL) => string;
  /** Requires an explicit baseUrl; credentials are never put in the URL. */
  webSocketUrl: (path: string | URL) => string;
  /** Authenticated fetch without reading the response or changing its stream semantics. */
  fetch: typeof globalThis.fetch;
  /** Like fetch, but rejects non-2xx responses with WorkspaceClientError. */
  request: (input: RequestInput, init?: RequestInit) => Promise<Response>;
  /** Decode a JSON response; empty/204 responses resolve to undefined. */
  json: <T>(input: RequestInput, init?: RequestInit) => Promise<T>;
};

export class WorkspaceClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: Record<string, unknown>;
  readonly url: string;
  readonly kind: "http" | "invalid-response";

  constructor(
    message: string,
    details: {
      status: number;
      code?: string;
      body?: Record<string, unknown>;
      url: string;
      kind: "http" | "invalid-response";
    },
  ) {
    super(message);
    this.name = "WorkspaceClientError";
    this.status = details.status;
    this.code = details.code;
    this.body = details.body;
    this.url = details.url;
    this.kind = details.kind;
  }
}

const relativeOrigin = "http://workspace.invalid";

function assertHttpUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new TypeError("Workspace service URLs must use HTTP or HTTPS.");
  if (url.username || url.password || url.hash)
    throw new TypeError("Workspace service URLs must not contain credentials or fragments.");
}

function inputUrl(input: RequestInput): string | URL {
  return typeof input === "string" || input instanceof URL ? input : input.url;
}

function inputHeaders(input: RequestInput): Headers | undefined {
  return typeof input === "string" || input instanceof URL ? undefined : input.headers;
}

function mergeHeaders(target: Headers, source?: RequestHeaders) {
  if (source) new Headers(source).forEach((value, name) => target.set(name, value));
}

function httpError(response: Response, value: unknown, url: string): WorkspaceClientError {
  const body =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const detail = typeof body?.error === "string" ? body.error : body?.message;
  return new WorkspaceClientError(
    typeof detail === "string" && detail.trim()
      ? detail.trim()
      : `请求失败（HTTP ${response.status}）。`,
    {
      status: response.status,
      code: typeof body?.code === "string" ? body.code : undefined,
      body,
      url,
      kind: "http",
    },
  );
}

export function createWorkspaceClient(options: WorkspaceClientOptions = {}): WorkspaceClient {
  const base = options.baseUrl === undefined ? undefined : new URL(options.baseUrl);
  if (base) {
    assertHttpUrl(base);
    if (base.search) throw new TypeError("Workspace baseUrl must not contain a query.");
  }
  const basePath = (options.basePath ?? "").replace(/\/+$/u, "");
  if (
    basePath &&
    (!basePath.startsWith("/") ||
      basePath.startsWith("//") ||
      // oxlint-disable-next-line no-control-regex -- reject URL parser normalization of control bytes.
      /[\\?#\u0000-\u0020\u007f]/u.test(basePath) ||
      new URL(basePath, relativeOrigin).pathname !== basePath)
  )
    throw new TypeError("Workspace basePath must be a normalized root-relative path.");

  const url = (path: string | URL): string => {
    const text = String(path);
    // URL parsers normalize backslashes and leading controls into authority delimiters.
    // oxlint-disable-next-line no-control-regex -- preserve the service-origin boundary before URL normalization.
    if (text !== text.trim() || /[\\\u0000-\u001f\u007f]/u.test(text) || text.includes("#"))
      throw new TypeError("Invalid workspace request URL.");
    const relative = text.startsWith("/") && !text.startsWith("//");
    if (!relative && !/^https?:\/\//iu.test(text))
      throw new TypeError("Workspace requests require a root-relative or HTTP(S) URL.");
    if (!base && !relative)
      throw new TypeError("Absolute workspace requests require an explicit baseUrl.");
    const target = new URL(text, base ?? relativeOrigin);
    assertHttpUrl(target);
    if (target.origin !== (base?.origin ?? relativeOrigin))
      throw new TypeError("Workspace requests must stay on the configured service origin.");
    if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))
      target.pathname = `${basePath}${target.pathname}`;
    return base ? target.href : `${target.pathname}${target.search}`;
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    // Validate before reading credentials, including for SDK-supplied Request objects.
    const target = url(inputUrl(input));
    const headers = new Headers(await options.getHeaders?.());
    mergeHeaders(headers, inputHeaders(input));
    mergeHeaders(headers, init?.headers);
    return (options.fetch ?? globalThis.fetch)(
      typeof input === "string" || input instanceof URL
        ? target
        : target === input.url ? input : new Request(target, input),
      {
        ...init,
        headers,
        // Never forward an authenticated request to a redirect destination, or replay a POST.
        redirect: "error",
      },
    );
  };

  const request = async (input: RequestInput, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init);
    if (!response.ok) {
      const text = await response.text();
      let value: unknown;
      try {
        value = text.trim() ? JSON.parse(text) : undefined;
      } catch {
        // A proxy/HTML failure must retain its HTTP status, not become a JSON parsing error.
      }
      throw httpError(response, value, url(inputUrl(input)));
    }
    return response;
  };

  return {
    url,
    webSocketUrl(path) {
      if (!base) throw new TypeError("WebSocket URLs require an explicit baseUrl.");
      const target = new URL(url(path));
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      return target.href;
    },
    fetch,
    request,
    async json<T>(input: RequestInput, init?: RequestInit): Promise<T> {
      const headers = new Headers(inputHeaders(input));
      mergeHeaders(headers, init?.headers);
      if (!headers.has("accept")) headers.set("accept", "application/json");
      if (typeof init?.body === "string" && !headers.has("content-type"))
        headers.set("content-type", "application/json");
      const response = await request(input, { ...init, headers });
      const text = await response.text();
      if (!text.trim()) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new WorkspaceClientError("服务返回了无法解析的 JSON 响应。", {
          status: response.status,
          url: url(inputUrl(input)),
          kind: "invalid-response",
        });
      }
    },
  };
}
