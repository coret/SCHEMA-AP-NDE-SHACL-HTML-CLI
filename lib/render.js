// JSON model -> self-contained HTML page.

import { readFileSync } from 'node:fs';

const template = readFileSync(new URL('./template.html', import.meta.url), 'utf8');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// <, >, & and the two line separators that are legal in JSON but not in older script parsers.
const UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/**
 * Serialise for embedding in <script type="application/json">: the output is still
 * valid JSON, but report content can never close the script element or start markup.
 */
export function embedJson(value) {
  return JSON.stringify(value).replace(UNSAFE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function renderHtml(model) {
  const fill = {
    TITLE: escapeHtml(model.meta.title || 'SCHEMA-AP-NDE SHACL Validation Report'),
    DATA: embedJson(model),
  };
  // Single pass, so a marker that happens to occur inside the data is never expanded.
  return template.replace(/\{\{(TITLE|DATA)\}\}/g, (_, key) => fill[key]);
}
