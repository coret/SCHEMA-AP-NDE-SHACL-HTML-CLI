// Loading of the data graph (any RDF format, file or URL, optionally gzipped) and the
// shapes graph (Turtle).

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';
import { Store, StreamParser, DataFactory } from 'n3';
import { rdfDereferencer } from 'rdf-dereference';
import { rdfParser } from 'rdf-parse';
import { parseTurtle } from './parse.js';

const { namedNode, quad } = DataFactory;

export const DEFAULT_SHAPES =
  'https://raw.githubusercontent.com/netwerk-digitaal-erfgoed/schema-profile/refs/heads/main/shacl.ttl';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDF_TYPE = `${RDF}type`;
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const SCHEMA_HTTP = 'http://schema.org/';
const SCHEMA_HTTPS = 'https://schema.org/';
const RDF_EXTENSION = /\.(nt|ttl|nq|trig|n3|jsonld|json|rdf|xml|owl|html?)$/i;
const TURTLE_FAMILY = /\.(nt|ttl|nq|trig|n3)$/i;
const GZIP = /\.gz$/i;

export const isUrl = (src) => /^https?:\/\//i.test(src);

/** Short display name of a source: file name, or last path segment / host of a URL. */
export function sourceName(src) {
  if (!isUrl(src)) return basename(src);
  const url = new URL(src);
  const segment = url.pathname.split('/').filter(Boolean).pop();
  return segment ? decodeURIComponent(segment) : url.hostname;
}

/** Local time as YYYYMMDD-HHMMSS, for file names. */
export function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * mh.nt -> mh.shacl.<timestamp>.html next to the input; a URL gives
 * <name>.shacl.<timestamp>.html in the current directory. A .gz suffix is dropped as well.
 */
export function defaultOutput(src, date = new Date()) {
  const name = sourceName(src).replace(GZIP, '').replace(RDF_EXTENSION, '');
  const suffix = `.shacl.${timestamp(date)}.html`;
  if (isUrl(src)) return `${name.replace(/[^\w.-]+/g, '_') || 'report'}${suffix}`;
  return join(dirname(src), `${name}${suffix}`);
}

/** Read the shapes graph (always Turtle). A URL is fetched on every call, never cached. */
export async function loadShapes(src = DEFAULT_SHAPES) {
  let text;
  if (isUrl(src)) {
    const response = await fetch(src, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    text = await response.text();
  } else {
    text = await readFile(src, 'utf8');
  }
  const { store, prefixes } = await parseTurtle(text);
  if (!store.size) throw new Error('the shapes graph is empty');
  return {
    store,
    prefixes,
    source: src,
    fetched: new Date().toISOString(),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

/**
 * The predicates the shapes can look at: every IRI in a sh:path, the predicates of
 * predicate-based targets and of property pair constraints, plus rdf:type and
 * rdfs:subClassOf (targets and sh:class). Statements with any other predicate cannot
 * change the outcome of SHACL Core validation, so they need not be kept in memory.
 *
 * Returns null when that reasoning does not hold: sh:closed looks at all predicates of
 * a node, and SPARQL or JavaScript constraints and targets can look at anything.
 */
export function shapeScope(shapes) {
  const objects = (p) => shapes.getObjects(null, namedNode(SH + p), null);
  const unsafe = ['sparql', 'target', 'js', 'jsFunctionName'].some((p) => objects(p).length)
    || objects('closed').some((t) => t.value === 'true' || t.value === '1');
  if (unsafe) return null;

  const predicates = new Set([RDF_TYPE, RDFS_SUBCLASS]);
  const seen = new Set();
  const walk = (term) => { // a path is an IRI or a blank node structure (lists, sh:inversePath, ...)
    if (term.termType === 'NamedNode') {
      if (!term.value.startsWith(SH) && !term.value.startsWith(RDF)) predicates.add(term.value);
      return;
    }
    if (term.termType !== 'BlankNode' || seen.has(term.id)) return;
    seen.add(term.id);
    for (const q of shapes.getQuads(term, null, null, null)) walk(q.object);
  };
  for (const term of objects('path')) walk(term);
  for (const p of ['targetSubjectsOf', 'targetObjectsOf', 'equals', 'disjoint', 'lessThan', 'lessThanOrEquals']) {
    for (const term of objects(p)) if (term.termType === 'NamedNode') predicates.add(term.value);
  }
  return predicates;
}

/** Stream of RDF/JS quads for a local file or URL, in any common serialisation, optionally .gz. */
async function quadStream(src, fail) {
  const name = isUrl(src) ? new URL(src).pathname : src;
  const gz = GZIP.test(name);
  const inner = name.replace(GZIP, '');
  const turtleFamily = TURTLE_FAMILY.test(inner);
  const baseIRI = isUrl(src) ? src : pathToFileURL(resolve(src)).href;

  // Anything that is not gzipped and is either remote or not Turtle-like: content
  // negotiation and format detection by rdf-dereference.
  if (!gz && (isUrl(src) || !turtleFamily)) {
    const { data } = await rdfDereferencer.dereference(isUrl(src) ? src : resolve(src), { localFiles: true });
    return data;
  }

  let raw;
  if (isUrl(src)) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    raw = Readable.fromWeb(response.body);
  } else {
    raw = createReadStream(src);
  }
  const stages = gz ? [raw, createGunzip()] : [raw];
  // The Turtle family goes straight to the n3 parser (fast, also for multi-GB dumps).
  if (turtleFamily) return pipeline(...stages, new StreamParser({ baseIRI }), (error) => error && fail(error));
  const bytes = stages.length > 1 ? pipeline(...stages, (error) => error && fail(error)) : raw;
  return rdfParser.parse(bytes, { path: inner, baseIRI });
}

/**
 * Read RDF from a local file or an http(s) URL into an n3 Store.
 *
 * - `keep`: Set of predicate IRIs to keep (see shapeScope); null keeps everything.
 * - `rewrite`: replace http://schema.org/ IRIs by their https://schema.org/ form.
 * - `onProgress(read)`: called every million statements.
 *
 * Returns `{ store, read, kept, legacy }`: statements read, statements kept, and the
 * number of statements that use the legacy http://schema.org/ namespace as predicate or class.
 */
export async function loadData(src, { keep = null, rewrite = false, onProgress = null } = {}) {
  const store = new Store();
  let read = 0;
  let legacy = 0;
  const fix = (term) => (term.termType === 'NamedNode' && term.value.startsWith(SCHEMA_HTTP)
    ? namedNode(SCHEMA_HTTPS + term.value.slice(SCHEMA_HTTP.length))
    : term);

  await new Promise((done, fail) => {
    quadStream(src, fail).then((stream) => {
      stream.on('data', (q) => {
        read++;
        const predicate = q.predicate.value;
        if (predicate.startsWith(SCHEMA_HTTP)
          || (predicate === RDF_TYPE && q.object.termType === 'NamedNode' && q.object.value.startsWith(SCHEMA_HTTP))) {
          legacy++;
        }
        if (rewrite) q = quad(fix(q.subject), fix(q.predicate), fix(q.object), q.graph);
        if (!keep || keep.has(q.predicate.value)) store.addQuad(q);
        if (onProgress && read % 1e6 === 0) onProgress(read);
      }).on('error', fail).on('end', done);
    }, fail);
  });

  return { store, read, kept: store.size, legacy };
}
