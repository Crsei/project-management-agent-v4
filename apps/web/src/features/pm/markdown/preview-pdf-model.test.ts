import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfCanvasSize, pdfDocumentOptions, pdfPreviewLimits } from './preview-pdf-model.ts';

test('PDF page canvases stay finite and bounded for ordinary, landscape, tall and high-DPI pages', () => {
  for (const [width, height, ratio] of [[595, 842, 1], [595, 842, 2], [842, 595, 8], [14_400, 14_400, 2], [1, 14_400, 1], [14_400, 1, 2]]) {
    const size = pdfCanvasSize(width!, height!, ratio);
    assert.ok(Number.isInteger(size.width) && Number.isInteger(size.height));
    assert.ok(size.width >= 1 && size.height >= 1);
    assert.ok(size.width <= pdfPreviewLimits.maxCanvasEdge && size.height <= pdfPreviewLimits.maxCanvasEdge);
    assert.ok(size.width * size.height <= pdfPreviewLimits.maxCanvasPixels);
    assert.ok(size.cssWidth > 0 && size.cssWidth <= pdfPreviewLimits.cssWidth);
    assert.ok(Number.isFinite(size.scale) && size.scale > 0);
  }
  assert.deepEqual(pdfCanvasSize(595, 842, 8), pdfCanvasSize(595, 842, 2));
  assert.deepEqual(pdfCanvasSize(595, 842, NaN), pdfCanvasSize(595, 842, 1));
});

test('invalid or excessive PDF geometry is rejected before allocating a canvas', () => {
  for (const [width, height] of [[0, 100], [100, 0], [-1, 100], [Infinity, 100], [100, NaN], [14_401, 100], [100, 14_401]]) assert.throws(() => pdfCanvasSize(width!, height!), /dimensions/);
});

test('PDF worker data is independently owned without refetch URLs, scripting or XFA viewer options', () => {
  const bytes = new Uint8Array([37, 80, 68, 70]);
  const options = pdfDocumentOptions(bytes);
  assert.deepEqual(options.data, bytes);
  assert.notEqual(options.data.buffer, bytes.buffer);
  options.data[0] = 0;
  assert.equal(bytes[0], 37);
  assert.equal(options.enableXfa, false);
  assert.equal(options.useWorkerFetch, false);
  assert.equal(options.disableRange, true);
  assert.equal(options.disableStream, true);
  assert.equal(options.disableAutoFetch, true);
  assert.equal(options.stopAtErrors, true);
  assert.equal(Object.hasOwn(options, 'url'), false);
  assert.equal(Object.hasOwn(options, 'docBaseUrl'), false);
  assert.equal(Object.hasOwn(options, 'enableScripting'), false);
  assert.equal(Object.hasOwn(options, 'isEvalSupported'), false);
  assert.throws(() => pdfDocumentOptions(new Uint8Array()), /empty/);
  assert.throws(() => pdfDocumentOptions(new Uint8Array(pdfPreviewLimits.maxBytes + 1)), /8 MiB/);
});
