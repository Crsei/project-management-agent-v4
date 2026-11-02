// Native port of OpenHands news-digest/main.py:399-690 (Copyright (c) 2025 OpenHands).
// MIT license: vendor/openhands-automations/LICENSE.extensions.
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { decodeHTML, decodeXML } from 'entities';

export type FeedEntry = { id: string; title: string; link: string; summary: string; published: number | null; source: string; feed: string };
export type SelectedEntry = FeedEntry & { keys: string[] };
type XmlNode = { [key: string]: unknown };
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, removeNSPrefix: true, trimValues: false, parseTagValue: false, processEntities: false, maxNestedTags: 100, cdataPropName: '#cdata' });
const children = (node: XmlNode): XmlNode[] => {
  const key = Object.keys(node).find(name => name !== ':@' && name !== '#text');
  return key && Array.isArray(node[key]) ? node[key] as XmlNode[] : [];
};
const nameOf = (node: XmlNode) => Object.keys(node).find(name => name !== ':@' && !name.startsWith('#') && !name.startsWith('?')) ?? '';
function textOf(nodes: XmlNode[]): string {
  return nodes.map(node => {
    if (typeof node['#text'] === 'string') return decodeXML(node['#text']);
    if (Array.isArray(node['#cdata'])) return (node['#cdata'] as XmlNode[]).map(part => typeof part['#text'] === 'string' ? part['#text'] : '').join('');
    return textOf(children(node));
  }).join('');
}
function childText(nodes: XmlNode[], names: string[]): string {
  for (const name of names) for (const node of nodes) if (nameOf(node) === name) {
    const text = textOf(children(node)).trim();
    if (text) return text;
  }
  return '';
}
export function stripFeedHtml(value: string): string {
  const strip = (text: string) => text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return strip(decodeHTML(strip(value))).replace(/\s+/g, ' ').trim();
}
export function parseFeedTimestamp(value: string): number | null {
  const input = value.trim();
  if (!input) return null;
  // Feed dates lacking a timezone mean UTC, not the process-local timezone.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/.exec(input);
  if (iso) {
    const year = Number(iso[1]), month = Number(iso[2]), day = Number(iso[3]);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(iso[4] ?? 0) > 23 || Number(iso[5] ?? 0) > 59 || Number(iso[6] ?? 0) > 59) return null;
  }
  const normalized = /^\d{4}-\d\d-\d\d(?:T| )\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(input) ? `${input}Z` : /\b\d{1,2}:\d\d(?::\d\d)?$/.test(input) ? `${input} GMT` : input;
  const result = Date.parse(normalized);
  return Number.isFinite(result) ? result : null;
}
export function parseFeed(xml: string, url: string): FeedEntry[] {
  if (Buffer.byteLength(xml, 'utf8') > 4 * 1024 * 1024) throw new Error('Feed exceeds 4 MiB');
  // No DTD/entities supplied by a feed: bounded input alone does not bound expansion.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Feed DTD/entity declarations are not allowed');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`Invalid feed XML: ${valid.err.msg}`);
  const document = parser.parse(xml) as XmlNode[];
  const root = document.find(node => nameOf(node));
  if (!root || !['rss', 'feed', 'rdf'].includes(nameOf(root).toLowerCase())) throw new Error('Document is not RSS, RDF or Atom');
  const nodes = children(root);
  let source = stripFeedHtml(childText(nodes, ['title']));
  if (!source) for (const node of nodes) if (!['item', 'entry'].includes(nameOf(node))) {
    source = stripFeedHtml(childText(children(node), ['title']));
    if (source) break;
  }
  source ||= new URL(url).host;
  const entries: FeedEntry[] = [];
  const walk = (items: XmlNode[]) => {
    for (const node of items) {
      const nested = children(node);
      if (['item', 'entry'].includes(nameOf(node))) {
        const title = stripFeedHtml(childText(nested, ['title']));
        let link = '', fallback = '';
        for (const child of nested) if (nameOf(child) === 'link') {
          const attributes = child[':@'] as Record<string, string> | undefined;
          const href = decodeXML(attributes?.['@_href'] ?? '').trim();
          if (href) {
            if ((attributes?.['@_rel'] ?? 'alternate').trim() === 'alternate') { link = href; break; }
            fallback ||= href;
          } else {
            const text = textOf(children(child)).trim();
            if (text) { link = text; break; }
          }
        }
        link ||= fallback;
        const id = childText(nested, ['guid', 'id']) || link || title;
        if (id) {
          const summary = stripFeedHtml(childText(nested, ['description', 'summary', 'content', 'encoded']));
          entries.push({ id, title: title || link, link, summary: summary.length >= 30 ? summary : '', published: parseFeedTimestamp(childText(nested, ['pubDate', 'published', 'date', 'updated', 'created'])), source, feed: url });
        }
      }
      walk(nested);
    }
  };
  walk(nodes);
  return entries;
}
export function canonicalFeedLink(value: string): string {
  if (!value.trim()) return '';
  // RSS identifiers need not be URLs. Keep malformed/relative identifiers stable as data.
  try {
    const url = new URL(value.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    url.search = url.searchParams.toString();
    return url.toString();
  } catch { return value.trim().replace(/#.*$/, '').replace(/\/+$/, '') || '/'; }
}
export function feedEntryKeys(entry: FeedEntry): string[] {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  const id = entry.id.trim(), link = canonicalFeedLink(entry.link);
  return [...new Set([...(id ? [hash(id)] : []), ...(link && link !== id ? [hash(link)] : [])])];
}
export function selectFeedEntries(entries: FeedEntry[], seen: ReadonlySet<string>, now: number): { items: SelectedEntry[]; funnel: { fetched: number; unseen: number; fresh: number } } {
  const funnel = { fetched: entries.length, unseen: 0, fresh: 0 }, taken = new Set<string>(), items: SelectedEntry[] = [];
  for (const entry of entries) {
    const keys = feedEntryKeys(entry);
    if (!keys.length || keys.some(key => seen.has(key) || taken.has(key))) continue;
    funnel.unseen++;
    if (entry.published !== null && entry.published < now - 48 * 60 * 60 * 1000) continue;
    funnel.fresh++;
    for (const key of keys) taken.add(key);
    items.push({ ...entry, keys });
  }
  items.sort((left, right) => (right.published ?? now) - (left.published ?? now));
  return { items: items.slice(0, 50), funnel };
}
