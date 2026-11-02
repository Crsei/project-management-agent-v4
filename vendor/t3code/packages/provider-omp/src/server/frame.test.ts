import { Buffer } from "node:buffer";
import { assert, describe, it } from "@effect/vitest";
import { OmpFrameDecoder, encodeOmpStdinFrame, OMP_MAX_FRAME_BYTES, OMP_MAX_REASSEMBLED_FRAME_BYTES } from "./frame.ts";

const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
function chunks(bytes: Buffer): Record<string, unknown>[] {
  const size = 256 * 1024;
  const count = Math.ceil(bytes.byteLength / size);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk", chunkId: "large", index, count, byteLength: bytes.byteLength,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }));
}
const large = Buffer.from(JSON.stringify({ type: "message_end", text: "文😀\u2028\u2029".repeat(110_000) }), "utf8");

 describe("OMP lossless frames", () => {
  it("preserves UTF-8 fragmented at every byte and does not split Unicode line separators", () => {
    const decoder = new OmpFrameDecoder();
    const output: unknown[] = [];
    const expected = { type: "message_update", delta: "文😀\u2028\u2029" };
    for (const byte of line(expected)) decoder.push(Uint8Array.of(byte), (record) => output.push(record));
    decoder.finish();
    assert.deepEqual(output, [expected]);
  });

  it("reassembles oversized v2 records without eliding strings or terminal messages", () => {
    const decoder = new OmpFrameDecoder();
    decoder.enableV2();
    const output: unknown[] = [];
    const physical = Buffer.concat(chunks(large).map(line));
    for (let offset = 0; offset < physical.byteLength; offset += 173) {
      decoder.push(physical.subarray(offset, offset + 173), (record) => output.push(record));
    }
    decoder.finish();
    assert.deepEqual(output, [JSON.parse(large.toString("utf8"))]);
  });

  it("does not allow chunks before successful v2 negotiation", () => {
    assert.throws(() => new OmpFrameDecoder().push(line(chunks(large)[0]), () => {}));
  });

  it.each([
    { index: 1 }, { index: -1 }, { index: 0.5 }, { count: 1 }, { count: 257 },
    { byteLength: OMP_MAX_REASSEMBLED_FRAME_BYTES + 1 }, { byteLength: 3 },
    { chunkId: "" }, { chunkId: "x".repeat(129) }, { data: "@@==" }, { data: "Zh==" },
  ])("rejects corrupt chunk metadata/payload %#", (patch) => {
    const decoder = new OmpFrameDecoder();
    decoder.enableV2();
    assert.throws(() => decoder.push(line({ ...chunks(large)[0], ...patch }), () => {}));
  });

  it.each(["interleaved", "interrupted", "duplicate", "mismatched length"])("fails closed on %s sequences", (scenario) => {
    const decoder = new OmpFrameDecoder();
    decoder.enableV2();
    const frames = chunks(large);
    decoder.push(line(frames[0]), () => {});
    const next = scenario === "interleaved" ? { ...frames[1], chunkId: "other" }
      : scenario === "interrupted" ? { type: "message_update", delta: "lost" }
      : scenario === "duplicate" ? frames[0]
      : { ...frames[1], byteLength: large.byteLength + 1 };
    assert.throws(() => decoder.push(line(next), () => {}));
    assert.throws(() => decoder.push(line({ type: "session_settled" }), () => {}));
  });

  it("rejects invalid UTF-8 instead of inserting replacement characters", () => {
    const decoder = new OmpFrameDecoder();
    assert.throws(() => decoder.push(Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125, 10]), () => {}));
    const bytes = Buffer.from(large);
    bytes[100] = 0xff;
    const logical = new OmpFrameDecoder();
    logical.enableV2();
    assert.throws(() => { for (const frame of chunks(bytes)) logical.push(line(frame), () => {}); });
  });

  it("fails on physical overflow, damaged JSON, primitives and unfinished EOF", () => {
    for (const bytes of [Buffer.alloc(OMP_MAX_FRAME_BYTES, 32), Buffer.from("oops\n"), Buffer.from("[]\n"), Buffer.from("null\n")]) {
      assert.throws(() => new OmpFrameDecoder().push(bytes, () => {}));
    }
    const partial = new OmpFrameDecoder();
    partial.push(Buffer.from('{"type":"session_settled"}'), () => {});
    assert.throws(() => partial.finish());
    const partialChunks = new OmpFrameDecoder();
    partialChunks.enableV2();
    partialChunks.push(line(chunks(large)[0]), () => {});
    assert.throws(() => partialChunks.finish());
  });

  it("checks stdin bytes including LF, rejects chunks and never truncates", () => {
    const record = { type: "prompt", message: "文😀" };
    const exact = line(record).byteLength;
    assert.equal(encodeOmpStdinFrame(record, exact).byteLength, exact);
    assert.throws(() => encodeOmpStdinFrame(record, exact - 1));
    assert.throws(() => encodeOmpStdinFrame({ type: "rpc_chunk", data: "e30=" }));
  });
});
