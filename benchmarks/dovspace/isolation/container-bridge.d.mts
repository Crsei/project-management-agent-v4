import type { IncomingMessage, RequestOptions, ServerResponse } from 'node:http';

export function forwardRequest(target: RequestOptions, incoming: IncomingMessage, outgoing: ServerResponse): void;
