import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceDocumentText from "../../../../../../../vendor/t3code/apps/server/src/provider/DocumentText.ts";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { resolveRegisteredDocumentPath, resolveRegisteredProviderPath } from "./attachments.ts";

const extensions: Record<string, true> = { docx: true, xlsx: true, pptx: true, odt: true, ods: true, odp: true, rtf: true, epub: true, ipynb: true };
export function pmDocumentTextWorkerEntry(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts")
    ? "../document-text-worker.ts" : "./providers/t3code/document-text-worker.mjs", import.meta.url));
}
export function resolveExtractedTextPath(file: string): Effect.Effect<string | undefined> {
  return Effect.sync(() => {
    if (!extensions[path.extname(file).slice(1).toLowerCase()] || !resolveRegisteredDocumentPath(file)) return undefined;
    const sidecar = file + ".txt";
    const resolved = resolveRegisteredProviderPath(sidecar);
    if (!resolved && existsSync(sidecar)) throw new Error("Unsafe Provider document text sidecar.");
    return resolved ?? undefined;
  });
}
/** Keep the source worker/cache/serialization algorithm; only bind PM paths and process environment. */
export function makePmDocumentText(context: ProviderDriverContext, workerPath = pmDocumentTextWorkerEntry()): Effect.Effect<SourceDocumentText.DocumentText["Service"], never, FileSystem.FileSystem> {
  return SourceDocumentText.make.pipe(
    Effect.provideService(HostProcess.Environment, { ...context.env }),
    Effect.provideService(SourceDocumentText.DocumentTextWorkerEntry, workerPath),
    Effect.map(documents => ({ ensure: file => Effect.gen(function* () {
      if (!extensions[path.extname(file).slice(1).toLowerCase()]) return undefined;
      const source = yield* Effect.sync(() => resolveRegisteredDocumentPath(file));
      if (!source) return yield* Effect.die(new Error("Provider document is missing or unregistered."));
      yield* Effect.sync(() => {
        for (const target of [source + ".txt", source + ".txt.part"]) {
          if (existsSync(target) && resolveRegisteredProviderPath(target) !== target) throw new Error("Unsafe Provider document extraction path.");
        }
      });
      const extracted = yield* documents.ensure(source);
      if (!extracted) return undefined;
      return yield* Effect.sync(() => {
        if (resolveRegisteredDocumentPath(source) !== source || resolveRegisteredProviderPath(extracted) !== extracted)
          throw new Error("Provider document changed during extraction.");
        return extracted;
      });
    }) })),
  );
}
export function makePmDocumentTextLayer(context: ProviderDriverContext, workerPath?: string) {
  return Layer.effect(SourceDocumentText.DocumentText, makePmDocumentText(context, workerPath));
}
