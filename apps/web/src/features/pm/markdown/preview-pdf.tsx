import React, { useEffect, useRef, useState } from 'react';
// Official compatibility builds include the library's TypedArray API polyfills in both realms.
import { AnnotationMode, getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { pdfCanvasSize, pdfDocumentOptions } from './preview-pdf-model';
import './preview-pdf.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Only known package resources may be fetched. No PDF-supplied URL or scripting runtime
// is loaded; the WASM glob deliberately includes image/color codecs, not QuickJS.
const resourceUrls = import.meta.glob<string>([
  '../../../../node_modules/pdfjs-dist/cmaps/*.bcmap',
  '../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '../../../../node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm',
], { eager: true, exhaustive: true, query: '?url', import: 'default' });
const bundledResources: Record<string, string> = Object.fromEntries(Object.entries(resourceUrls).map(([path, url]) => [path.split('/').slice(-2).join('/'), url]));
const resourceFolders: Record<string, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };

type LoadedPdf = { bytes: Uint8Array; document?: PDFDocumentProxy; error?: string };
type PageResult = { document: PDFDocumentProxy; page: number; error?: string };

/** Canvas-only PDF.js rendering: no viewer, annotation/link layer, scripting manager or XFA.
 * PDF.js 6 removed isEvalSupported; use only supported options rather than a meaningless flag. */
export function PdfPreview({ bytes, label }: { bytes: Uint8Array; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<LoadedPdf | null>(null);
  const [selection, setSelection] = useState<{ bytes: Uint8Array; page: number }>({ bytes, page: 1 });
  const [rendered, setRendered] = useState<PageResult | null>(null);
  const active = loaded?.bytes === bytes ? loaded : null;
  const document = active?.document;
  const pageNumber = selection.bytes === bytes ? selection.page : 1;

  useEffect(() => {
    let current = true; let task: PDFDocumentLoadingTask | undefined;
    const abort = new AbortController();
    class BundledPdfDataFactory {
      async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
        const folder = Object.hasOwn(resourceFolders, kind) ? resourceFolders[kind] : undefined;
        const key = `${folder}/${filename}`;
        if (!folder || !Object.hasOwn(bundledResources, key)) throw new Error('PDF resource is not available in the bundled preview.');
        const response = await fetch(bundledResources[key]!, { signal: abort.signal, credentials: 'omit' });
        if (!response.ok) throw new Error('Unable to load the bundled PDF resource.');
        return new Uint8Array(await response.arrayBuffer());
      }
    }
    try {
      task = getDocument({ ...pdfDocumentOptions(bytes), BinaryDataFactory: BundledPdfDataFactory });
      void task.promise.then(pdf => { if (current) setLoaded({ bytes, document: pdf }); }, error => { if (current) setLoaded({ bytes, error: error instanceof Error ? error.message : 'Unable to read this PDF. Download the original file.' }); });
    } catch (error) { setLoaded({ bytes, error: error instanceof Error ? error.message : 'Unable to read this PDF. Download the original file.' }); }
    return () => {
      current = false; abort.abort();
      // Loading-task destruction also destroys its document transport and worker. Expected
      // cancellation rejections must not surface after the authorized document unmounts.
      void task?.destroy().catch(() => undefined);
    };
  }, [bytes]);

  useEffect(() => {
    if (!document || !canvas.current) return;
    const target = canvas.current;
    let current = true; let rendering: RenderTask | undefined; let page: PDFPageProxy | undefined;
    void document.getPage(pageNumber).then(async value => {
      page = value;
      if (!current) { page.cleanup(); return; }
      const geometry = page.getViewport({ scale: 1 });
      const size = pdfCanvasSize(geometry.width, geometry.height, window.devicePixelRatio);
      target.width = size.width; target.height = size.height; target.style.width = `${size.cssWidth}px`;
      rendering = page.render({ canvas: target, viewport: page.getViewport({ scale: size.scale }), intent: 'display', annotationMode: AnnotationMode.DISABLE, background: '#ffffff' });
      await rendering.promise;
      if (current) setRendered({ document, page: pageNumber });
    }).catch(error => { if (current) setRendered({ document, page: pageNumber, error: error instanceof Error ? error.message : 'Unable to render this PDF page. Download the original file.' }); });
    return () => {
      current = false;
      if (rendering) {
        rendering.cancel();
        void rendering.promise.then(() => { page?.cleanup(); target.width = target.height = 0; }, () => { page?.cleanup(); target.width = target.height = 0; });
      } else { page?.cleanup(); target.width = target.height = 0; }
    };
  }, [document, pageNumber]);

  if (active?.error) return <span className="inline-error" role="alert">PDF: {active.error}</span>;
  if (!document) return <span role="status">Loading PDF…</span>;
  const result = rendered?.document === document && rendered.page === pageNumber ? rendered : null;
  return <span className="md-pdf-preview" role="group" aria-label={label || 'PDF attachment'}>
    <span className="md-pdf-toolbar"><button type="button" aria-label="Previous PDF page" disabled={pageNumber <= 1} onClick={() => setSelection({ bytes, page: pageNumber - 1 })}>← Previous</button><output aria-live="polite">Page {pageNumber} / {document.numPages}</output><button type="button" aria-label="Next PDF page" disabled={pageNumber >= document.numPages} onClick={() => setSelection({ bytes, page: pageNumber + 1 })}>Next →</button></span>
    {result?.error ? <span className="inline-error" role="alert">PDF: {result.error}</span> : !result ? <span role="status">Rendering PDF page {pageNumber}…</span> : null}
    <span className="md-pdf-page"><canvas key={pageNumber} ref={canvas} role="img" aria-label={`${label || 'PDF attachment'}, page ${pageNumber} of ${document.numPages}`} hidden={!!result?.error}>PDF page {pageNumber}. Download the original file for another viewer.</canvas></span>
    <span className="md-pdf-note">Canvas preview only; document scripts, links, forms and XFA are disabled. Very large images are subject to preview safety limits.</span>
  </span>;
}
