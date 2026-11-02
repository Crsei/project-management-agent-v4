// Protocol reference: oh-my-pi v18.13.2, e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e,
// docs/rpc.md and packages/coding-agent/src/modes/rpc/rpc-frame.ts (MIT).
// Local byte framer: no Bun or OMP runtime imports, no truncation or recovery after corruption.
import { Buffer } from "node:buffer";

export const OMP_MAX_FRAME_BYTES = 1024 * 1024;
export const OMP_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type OmpFrameRecord = Record<string, unknown>;

function object(value: unknown): OmpFrameRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OMP RPC frame must be an object");
  }
  return value as OmpFrameRecord;
}

interface Chunks {
  readonly id: string;
  readonly count: number;
  readonly bytes: Buffer;
  nextIndex: number;
  offset: number;
}

/** Stateful, strict LF JSONL + v2 reassembler. Any thrown error poisons the decoder. */
export class OmpFrameDecoder {
  private parts: Uint8Array[] = [];
  private physicalBytes = 0;
  private pending: Chunks | undefined;
  private poisoned = false;
  private v2 = false;
  private physicalLimit = OMP_MAX_FRAME_BYTES;
  private logicalLimit = OMP_MAX_REASSEMBLED_FRAME_BYTES;

  setLimits(maxFrameBytes: number, maxReassembledFrameBytes: number): void {
    if (
      !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 128 ||
      maxFrameBytes > OMP_MAX_FRAME_BYTES ||
      !Number.isSafeInteger(maxReassembledFrameBytes) ||
      maxReassembledFrameBytes < maxFrameBytes ||
      maxReassembledFrameBytes > OMP_MAX_REASSEMBLED_FRAME_BYTES
    ) throw new Error("Invalid OMP advertised transport limits");
    this.physicalLimit = maxFrameBytes;
    this.logicalLimit = maxReassembledFrameBytes;
  }

  enableV2(): void {
    this.v2 = true;
  }

  /** Invokes onFrame synchronously in wire order (negotiation can enable v2 mid-read). */
  push(chunk: Uint8Array, onFrame: (record: OmpFrameRecord) => void): void {
    if (this.poisoned) throw new Error("OMP RPC decoder is closed after an error");
    try {
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 10) continue;
        const fragment = chunk.subarray(start, index);
        this.append(fragment);
        // Physical limit includes the LF, even for CRLF frames.
        if (this.physicalBytes + 1 > this.physicalLimit) throw new Error("OMP RPC physical frame limit exceeded");
        if (this.physicalBytes === 0) throw new Error("Empty OMP RPC stdout frame");
        const bytes = this.parts.length === 1
          ? this.parts[0]!
          : Buffer.concat(this.parts, this.physicalBytes);
        const length = bytes[bytes.byteLength - 1] === 13 ? bytes.byteLength - 1 : bytes.byteLength;
        const physical = object(JSON.parse(UTF8.decode(bytes.subarray(0, length))));
        this.parts = [];
        this.physicalBytes = 0;
        const record = this.logical(physical);
        if (record !== undefined) onFrame(record);
        start = index + 1;
      }
      this.append(chunk.subarray(start));
    } catch (error) {
      this.poisoned = true;
      this.parts = [];
      this.pending = undefined;
      throw error;
    }
  }

  finish(): void {
    if (this.poisoned || this.physicalBytes !== 0 || this.pending !== undefined) {
      this.poisoned = true;
      throw new Error("Truncated OMP RPC frame or chunk sequence at EOF");
    }
  }

  private append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (this.physicalBytes + bytes.byteLength + 1 > this.physicalLimit) {
      throw new Error("OMP RPC physical frame limit exceeded");
    }
    this.parts.push(bytes);
    this.physicalBytes += bytes.byteLength;
  }

  private logical(record: OmpFrameRecord): OmpFrameRecord | undefined {
    if (record.type !== "rpc_chunk") {
      if (this.pending !== undefined) throw new Error("Interrupted OMP RPC chunk sequence");
      return record;
    }
    if (!this.v2) throw new Error("OMP RPC chunks received before v2 negotiation");
    const { chunkId, index, count, byteLength, data } = record;
    if (
      typeof chunkId !== "string" || chunkId.length === 0 || chunkId.length > 128 ||
      typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 ||
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 2 ||
      count > Math.ceil(this.logicalLimit / MAX_CHUNK_BYTES) || index >= count ||
      typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) ||
      byteLength < this.physicalLimit || byteLength > this.logicalLimit ||
      typeof data !== "string" || data.length === 0 ||
      data.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) throw new Error("Invalid OMP RPC chunk metadata or base64");
    const decoded = Buffer.from(data, "base64");
    if (decoded.byteLength > MAX_CHUNK_BYTES || decoded.toString("base64") !== data) {
      throw new Error("Invalid OMP RPC chunk payload");
    }
    if (this.pending === undefined) {
      if (index !== 0) throw new Error("OMP RPC chunk sequence must start at zero");
      this.pending = { id: chunkId, count, bytes: Buffer.allocUnsafe(byteLength), nextIndex: 0, offset: 0 };
    }
    const pending = this.pending;
    if (pending.id !== chunkId || pending.count !== count || pending.bytes.byteLength !== byteLength || pending.nextIndex !== index) {
      throw new Error("Mismatched OMP RPC chunk sequence");
    }
    if (pending.offset + decoded.byteLength > byteLength) throw new Error("OMP RPC chunk sequence exceeds declared length");
    decoded.copy(pending.bytes, pending.offset);
    pending.offset += decoded.byteLength;
    pending.nextIndex += 1;
    if (pending.nextIndex !== count) return undefined;
    if (pending.offset !== byteLength) throw new Error("OMP RPC chunk sequence length mismatch");
    this.pending = undefined;
    const logical = object(JSON.parse(UTF8.decode(pending.bytes)));
    if (logical.type === "rpc_chunk") throw new Error("Nested OMP RPC chunks are invalid");
    return logical;
  }
}

/** OMP does not reassemble stdin: never send an oversized host result or prompt. */
export function encodeOmpStdinFrame(record: OmpFrameRecord, limit = OMP_MAX_FRAME_BYTES): Uint8Array {
  object(record);
  if (record.type === "rpc_chunk") throw new Error("OMP stdin does not support rpc_chunk");
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, "utf8") + 1 > limit) throw new Error("OMP RPC stdin frame limit exceeded");
  return Buffer.from(`${json}\n`, "utf8");
}
