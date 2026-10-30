// Streaming projection for native JSONL records; discards unselected message and tool bodies.
// Adapted from t3code's AgentSessionJson/usageTranscriptReader selection design.
// Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code.
import { StringDecoder } from "node:string_decoder";
import type { SelectedFields } from "@t3tools/provider-core/server/usage";

type Selection = true | SelectedFields;
type Frame = { type: "object" | "array"; selection: Selection | undefined; value: Record<string, unknown> | unknown[] | undefined; state: string; key: string; index: number };
const MAX_SELECTED = 2 * 1024 * 1024;
const MAX_DEPTH = 128;

/** Incremental JSON parser retaining only the provider's selected paths. */
export class TranscriptProjector {
  private decoder = new StringDecoder("utf8");
  private stack: Frame[] = [];
  private root: unknown;
  private rootDone = false;
  private mode: "normal" | "string" | "primitive" = "normal";
  private token = "";
  private stringKey = false;
  private capture = false;
  private escape = false;
  private unicode = 0;
  private selectedBytes = 0;
  private selection: Selection;
  constructor(selection: SelectedFields) { this.selection = selection; }
  private selected(): Selection | undefined {
    const parent = this.stack.at(-1);
    if (!parent) return this.rootDone ? undefined : this.selection;
    if (parent.selection === true) return true;
    return parent.type === "object" && parent.selection && Object.hasOwn(parent.selection, parent.key) ? parent.selection[parent.key] : undefined;
  }
  private add(value: unknown, selection: Selection | undefined): void {
    if (selection) {
      this.selectedBytes += 16;
      if (this.selectedBytes > MAX_SELECTED) throw new Error("Selected JSON exceeds limit");
    }
    const parent = this.stack.at(-1);
    if (!parent) { if (this.rootDone) throw new Error("Extra JSON value"); this.rootDone = true; if (selection) this.root = value; return; }
    if (parent.type === "object") {
      if (parent.state !== "value") throw new Error("Expected object value");
      if (selection && parent.value && !Array.isArray(parent.value)) Object.defineProperty(parent.value, parent.key, { value, enumerable: true, writable: true, configurable: true });
      parent.state = "comma";
    } else {
      if (parent.state !== "value" && parent.state !== "first") throw new Error("Expected array value");
      if (selection && Array.isArray(parent.value)) parent.value.push(value);
      parent.index++; parent.state = "comma";
    }
  }
  private addToken(): void {
    if (!this.token) throw new Error("Empty primitive");
    const value: unknown = JSON.parse(this.token); if (typeof value === "object" && value !== null) throw new Error("Invalid primitive");
    this.add(value, this.selected()); this.token = ""; this.mode = "normal";
  }
  private append(character: string): void {
    this.token += character;
    if (++this.selectedBytes > MAX_SELECTED) throw new Error("Selected JSON exceeds limit");
  }
  private consume(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (this.mode === "string") {
        if (this.capture) this.append(ch);
        if (this.unicode) { if (!/[0-9a-f]/i.test(ch)) throw new Error("Invalid JSON escape"); this.unicode--; continue; }
        if (this.escape) { this.escape = false; if (ch === "u") this.unicode = 4; else if (!'"\\/bfnrt'.includes(ch)) throw new Error("Invalid JSON escape"); continue; }
        if (ch === "\\") { this.escape = true; continue; }
        if (ch === '"') {
          const value = this.capture ? JSON.parse(this.token) as string : "";
          this.token = ""; this.mode = "normal";
          if (this.stringKey) { const parent = this.stack.at(-1)!; parent.key = value; parent.state = "colon"; }
          else this.add(value, this.selected());
        } else if (ch.charCodeAt(0) < 32) throw new Error("Invalid JSON string");
        continue;
      }
      if (this.mode === "primitive") {
        if (!/[\s,}\]]/.test(ch)) { if (this.token.length >= 128) throw new Error("Invalid JSON primitive"); this.token += ch; continue; }
        this.addToken(); i--; continue;
      }
      if (/\s/.test(ch)) continue;
      const parent = this.stack.at(-1);
      if (ch === ":") { if (!parent || parent.type !== "object" || parent.state !== "colon") throw new Error("Unexpected colon"); parent.state = "value"; continue; }
      if (ch === ",") { if (!parent || parent.state !== "comma") throw new Error("Unexpected comma"); parent.state = parent.type === "object" ? "key" : "value"; continue; }
      if (ch === "}" || ch === "]") {
        if (!parent || (ch === "}" ? parent.type !== "object" : parent.type !== "array") || (parent.state !== "first" && parent.state !== "comma")) throw new Error("Unexpected container end");
        this.stack.pop(); continue;
      }
      if (ch === '"') {
        this.stringKey = !!parent && parent.type === "object" && (parent.state === "first" || parent.state === "key");
        this.capture = this.stringKey || this.selected() !== undefined; this.mode = "string"; this.token = ""; this.escape = false; this.unicode = 0;
        if (this.capture) this.append(ch); continue;
      }
      if (ch === "{" || ch === "[") {
        if (this.stack.length >= MAX_DEPTH) throw new Error("JSON nesting exceeds limit");
        const selection = this.selected(); const value = selection ? (ch === "{" ? Object.create(null) as Record<string, unknown> : [] as unknown[]) : undefined;
        this.add(value, selection); this.stack.push({ type: ch === "{" ? "object" : "array", selection, value, state: "first", key: "", index: 0 }); continue;
      }
      this.mode = "primitive"; this.token = ch;
    }
  }
  write(bytes: Buffer): void { this.consume(this.decoder.write(bytes)); }
  finish(): unknown {
    this.consume(this.decoder.end()); if (this.mode === "primitive") this.addToken();
    if (this.mode !== "normal" || this.stack.length || !this.rootDone) throw new Error("Incomplete JSON");
    return this.root;
  }
}
