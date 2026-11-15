import type { Stats } from 'node:fs';

export function assertPrivatePath(path: string, directory?: boolean): Promise<Stats>;
export function ensurePrivateDirectory(input: string, options?: { newlyCreated?: boolean }): Promise<string>;
export function securePrivateFile(path: string, options?: { newlyCreated?: boolean }): Promise<void>;
/** Raw JSON.parse boundary; existing consumers supply their own schema validation. */
export function readPrivateJson(path: string, maximum?: number): Promise<any>;
export function writePrivateJson(path: string, value: unknown, options?: { exclusive?: boolean }): Promise<void>;
