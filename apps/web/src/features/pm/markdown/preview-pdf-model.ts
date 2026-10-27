export const pdfPreviewLimits = { maxBytes: 8 * 1024 * 1024, maxPagePoints: 14_400, maxCanvasEdge: 4096, maxCanvasPixels: 8 * 1024 * 1024, maxImagePixels: 16 * 1024 * 1024, cssWidth: 720, maxDeviceScale: 2 };

export interface PdfCanvasSize { width: number; height: number; scale: number; cssWidth: number }

/** Bound both page geometry and bitmap allocation before assigning canvas dimensions. */
export function pdfCanvasSize(pageWidth: number, pageHeight: number, deviceScale = 1): PdfCanvasSize {
  if (![pageWidth, pageHeight].every(value => Number.isFinite(value) && value >= 1 && value <= pdfPreviewLimits.maxPagePoints)) throw new Error('PDF page dimensions exceed the safe preview limit. Download the original file to view this page.');
  const ratio = Number.isFinite(deviceScale) ? Math.max(1, Math.min(pdfPreviewLimits.maxDeviceScale, deviceScale)) : 1;
  const scale = Math.min(pdfPreviewLimits.cssWidth * ratio / pageWidth, pdfPreviewLimits.maxCanvasEdge / pageWidth, pdfPreviewLimits.maxCanvasEdge / pageHeight, Math.sqrt(pdfPreviewLimits.maxCanvasPixels / (pageWidth * pageHeight)));
  const width = Math.max(1, Math.floor(pageWidth * scale)); const height = Math.max(1, Math.floor(pageHeight * scale));
  return { width, height, scale, cssWidth: Math.min(pdfPreviewLimits.cssWidth, width / ratio) };
}

/** The worker takes ownership of its data buffer. Keep the authenticated input intact for
 * StrictMode remounts and the independent download Blob; paging reuses the loaded document. */
export function pdfDocumentOptions(bytes: Uint8Array) {
  if (!bytes.byteLength || bytes.byteLength > pdfPreviewLimits.maxBytes) throw new Error('PDF content is empty or exceeds the 8 MiB preview limit.');
  return { data: bytes.slice(), enableXfa: false, useWorkerFetch: false, useSystemFonts: true, disableRange: true, disableStream: true, disableAutoFetch: true, stopAtErrors: true, maxImageSize: pdfPreviewLimits.maxImagePixels, canvasMaxAreaInBytes: pdfPreviewLimits.maxCanvasPixels * 4 };
}
