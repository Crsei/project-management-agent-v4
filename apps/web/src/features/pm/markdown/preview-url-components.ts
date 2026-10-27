import { createElement } from 'react';
import type { ComponentProps } from 'react';
import type { ExtraProps } from 'react-markdown';
import { safeExternalUrl } from './preview-syntax.ts';

/** Passive Markdown URLs are not authenticated artifact references. */
export function MarkdownUrlLink({ node: _node, href, children, ...props }: ComponentProps<'a'> & ExtraProps) {
  const safe = href && safeExternalUrl(href);
  return safe ? createElement('a', { ...props, href: safe, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, children) : createElement('span', null, children);
}

export function MarkdownUrlImage({ node: _node, src, alt = '', title, width, height }: ComponentProps<'img'> & ExtraProps) {
  const safe = typeof src === 'string' && safeExternalUrl(src);
  if (!safe || /^mailto:/i.test(safe)) return createElement('span', { className: 'inline-error' }, `Image unavailable: ${alt}`);
  if (/\.(?:pdf|svg|html?)(?:[?#]|$)/i.test(safe)) return createElement('a', { href: safe, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' }, alt || 'External media (not an uploaded attachment)');
  const imageWidth = typeof width === 'number' && width > 0 && width <= 4096 ? width : undefined;
  const imageHeight = typeof height === 'number' && height > 0 && height <= 4096 ? height : undefined;
  return createElement('img', { src: safe, alt, title, width: imageWidth, height: imageHeight, style: { height: imageHeight ?? 'auto' }, loading: 'lazy', referrerPolicy: 'no-referrer' });
}
