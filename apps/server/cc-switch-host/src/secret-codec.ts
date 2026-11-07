/** Translated from apps/server/cc-switch-host/src/secret_codec.rs. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors.ts";

let key: Buffer | undefined;

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new AppError("INITIALIZATION_FAILED", "Invalid context key encoding");
  return Buffer.from(value, "base64");
}

export function initialize(encoded: string): void {
  if (key) throw new AppError("INITIALIZATION_FAILED", "Context key already initialized");
  const decoded = decodeBase64(encoded);
  if (decoded.length !== 32) {
    decoded.fill(0);
    throw new AppError("INITIALIZATION_FAILED", "Context key must contain 32 bytes");
  }
  key = Buffer.from(decoded);
  decoded.fill(0);
}

function cipherKey(): Buffer {
  if (!key) throw new AppError("INITIALIZATION_FAILED", "Context key is not initialized");
  return key;
}

function aad(id: string): Buffer {
  return Buffer.concat([Buffer.from("cc-switch-host:mcp:v1:", "utf8"), Buffer.from(id, "utf8")]);
}

function overrideAad(id: string, app: string): Buffer {
  return Buffer.concat([
    Buffer.from("cc-switch-host:mcp-agent-override:v1:", "utf8"),
    Buffer.from(JSON.stringify([id, app]), "utf8"),
  ]);
}

function sealBound(binding: Buffer, value: unknown): string {
  const nonce = randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", cipherKey(), nonce);
    cipher.setAAD(binding);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({
      $ccSwitchSealed: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  } finally {
    plaintext.fill(0);
  }
}

function openBound(binding: Buffer, stored: string): unknown {
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(stored) as Record<string, unknown>; } catch { throw new AppError("DATABASE", "Invalid protected MCP record"); }
  if (envelope.$ccSwitchSealed !== 1) throw new AppError("DATABASE", "Unprotected MCP record refused; import through the protected host");
  const nonce = decodeEnvelopeField(envelope.nonce);
  const ciphertext = decodeEnvelopeField(envelope.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 16) throw new AppError("DATABASE", "Invalid protected MCP record");
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", cipherKey(), nonce);
    decipher.setAAD(binding);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new AppError("DATABASE", "Context key authentication failed");
  }
  try { return JSON.parse(plaintext.toString("utf8")); } finally { plaintext.fill(0); }
}

function decodeEnvelopeField(value: unknown): Buffer {
  if (typeof value !== "string") throw new AppError("DATABASE", "Invalid protected MCP record");
  try { return decodeBase64(value); } catch { throw new AppError("DATABASE", "Invalid protected MCP record"); }
}

export function seal(id: string, value: unknown): string { return sealBound(aad(id), value); }
export function open(id: string, stored: string): unknown { return openBound(aad(id), stored); }
export function sealOverride(id: string, app: string, value: unknown): string { return sealBound(overrideAad(id, app), value); }
export function openOverride(id: string, app: string, stored: string): unknown { return openBound(overrideAad(id, app), stored); }

export function initializeForTests(): void {
  key = Buffer.alloc(32, 0x42);
}
