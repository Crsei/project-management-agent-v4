import { Buffer } from 'node:buffer';

export type SatoriBotStatus = {
  platform: string;
  selfId: string;
  name: string | null;
  status: 'online' | 'offline' | 'connecting' | 'unknown';
};

export type SatoriConnectionStatus = {
  state: 'disconnected' | 'connecting' | 'ready' | 'auth_failed' | 'error';
  readyAt: string | null;
  lastEventAt: string | null;
  lastErrorCode: string | null;
  bots: SatoriBotStatus[];
};

type SocketEvent = { data?: unknown; code?: number; reason?: string };
type Listener = (event: SocketEvent) => void;
export type SatoriSocket = {
  addEventListener(type: string, listener: Listener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
};

type SatoriPayload = { op?: number; body?: unknown };
type RawLogin = { platform?: unknown; user?: unknown; selfId?: unknown; self_id?: unknown; status?: unknown };

function satoriEventsUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/events`;
  return url.href;
}

function botStatus(value: unknown): SatoriBotStatus['status'] {
  switch (Number(value)) {
    case 1: return 'online';
    case 0: return 'offline';
    case 2: return 'connecting';
    default: return 'unknown';
  }
}

function readBots(body: unknown): SatoriBotStatus[] {
  if (!body || typeof body !== 'object' || !('logins' in body) || !Array.isArray(body.logins)) return [];
  return body.logins.slice(0, 20).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const login = value as RawLogin;
    const user = login.user && typeof login.user === 'object' ? login.user as { id?: unknown; name?: unknown } : null;
    const selfId = typeof user?.id === 'string' ? user.id
      : typeof login.self_id === 'string' ? login.self_id
        : typeof login.selfId === 'string' ? login.selfId : null;
    const platform = typeof login.platform === 'string' ? login.platform : null;
    if (!selfId || !platform) return [];
    return [{ platform, selfId, name: typeof user?.name === 'string' ? user.name : null, status: botStatus(login.status) }];
  });
}

export type SatoriClient = {
  start(): void;
  stop(): void;
  status(): SatoriConnectionStatus;
};

function socketData(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  return null;
}

/** Minimal Satori v1 client. Bot identities come from READY logins, never from the resumable session counter. */
export function createSatoriClient(options: {
  url: string;
  token: string;
  onEvent: (body: unknown) => void | Promise<void>;
  onError?: (code: string) => void;
  socketFactory?: (url: string) => SatoriSocket;
  heartbeatMs?: number;
}): SatoriClient {
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const status: SatoriConnectionStatus = { state: 'disconnected', readyAt: null, lastEventAt: null, lastErrorCode: null, bots: [] };
  const factory = options.socketFactory ?? (url => new globalThis.WebSocket(url) as unknown as SatoriSocket);
  let stopped = true, socket: SatoriSocket | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined, lastPong = 0, attempt = 0, sn = 0;

  function clearHeartbeat() {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  function fail(code: string) {
    status.lastErrorCode = code;
    if (status.state !== 'auth_failed') status.state = 'error';
    options.onError?.(code);
  }
  function scheduleReconnect() {
    if (stopped) return;
    const delay = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt = Math.min(attempt + 1, 5);
    reconnectTimer = setTimeout(connect, delay);
  }
  function connect() {
    if (stopped) return;
    reconnectTimer = undefined;
    status.state = 'connecting';
    status.readyAt = null;
    status.bots = [];
    let next: SatoriSocket;
    try { next = factory(satoriEventsUrl(options.url)); }
    catch { fail('satori_connect_failed'); scheduleReconnect(); return; }
    socket = next;
    next.addEventListener('open', () => {
      if (stopped || socket !== next) return;
      status.state = 'connecting';
      attempt = 0;
      lastPong = Date.now();
      next.send(JSON.stringify({ op: 3, body: { token: options.token, ...(sn > 0 ? { sn } : {}) } }));
      clearHeartbeat();
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastPong > heartbeatMs * 3) {
          fail('satori_heartbeat_timeout');
          next.close(4001, 'heartbeat timeout');
          return;
        }
        next.send(JSON.stringify({ op: 1, body: {} }));
      }, heartbeatMs);
    });
    next.addEventListener('message', event => {
      if (stopped || socket !== next) return;
      const raw = socketData(event.data);
      if (raw === null) return;
      let payload: SatoriPayload;
      try { payload = JSON.parse(raw) as SatoriPayload; }
      catch { return; }
      lastPong = Date.now();
      if (payload.op === 4) {
        status.state = 'ready';
        status.readyAt = new Date().toISOString();
        status.lastErrorCode = null;
        status.bots = readBots(payload.body);
        return;
      }
      if (payload.op === 2) return;
      if (payload.op === 1) { next.send(JSON.stringify({ op: 2, body: {} })); return; }
      if (payload.op !== 0 || payload.body === null || typeof payload.body !== 'object') return;
      const eventBody = payload.body as { sn?: unknown };
      if (typeof eventBody.sn === 'number' && Number.isSafeInteger(eventBody.sn) && eventBody.sn > sn) sn = eventBody.sn;
      status.lastEventAt = new Date().toISOString();
      Promise.resolve(options.onEvent(eventBody)).catch(() => {
        status.lastErrorCode = 'satori_event_failed';
        options.onError?.('satori_event_failed');
      });
    });
    next.addEventListener('close', event => {
      if (socket !== next) return;
      socket = undefined;
      status.readyAt = null;
      status.bots = [];
      clearHeartbeat();
      if (event.code === 4004) {
        stopped = true;
        status.state = 'auth_failed';
        fail('satori_auth_failed');
        return;
      }
      status.state = 'disconnected';
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      if (socket !== next) return;
      fail('satori_connect_failed');
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      clearHeartbeat();
      const current = socket;
      socket = undefined;
      status.state = 'disconnected';
      status.readyAt = null;
      status.bots = [];
      current?.close(1000, 'stopped');
    },
    status(): SatoriConnectionStatus {
      return { ...status, bots: status.bots.map(bot => ({ ...bot })) };
    },
  };
}

export function satoriMethodUrl(base: string, method: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/${method}`;
  return url.href;
}

/** Only Satori's message.create is exposed; response bodies are discarded and never logged. */
export async function sendSatoriMessage(options: {
  apiUrl: string;
  token: string;
  platform: string;
  selfId: string;
  channelId: string;
  content: string;
  timeoutMs: number;
}): Promise<{ status: number }> {
  const response = await fetch(satoriMethodUrl(options.apiUrl, 'message.create'), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
      'satori-user-id': options.selfId,
      'satori-platform': options.platform,
    },
    body: JSON.stringify({ channel_id: options.channelId, content: options.content }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  await response.body?.cancel().catch(() => undefined);
  return { status: response.status };
}
