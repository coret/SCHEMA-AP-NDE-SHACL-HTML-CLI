#!/usr/bin/env node
// SCHEMA-AP-NDE-SHACL-HTML-CLI: validate RDF (file or URL) against the SCHEMA-AP-NDE SHACL shapes
// and write the result as a self-contained HTML page.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_SHAPES, defaultOutput, isUrl, loadData, loadShapes, shapeScope, sourceName } from './lib/load.js';
import { buildModelFromResults, severityCounts } from './lib/parse.js';
import { renderHtml } from './lib/render.js';
import { engineVersion, hasTargets, resultAdapter, validate } from './lib/validate.js';

const USAGE = `Usage: schema-ap-nde-shacl-html-cli <file-or-url> [options]

Validates RDF data (Turtle, N-Triples, N-Quads, TriG, JSON-LD, RDF/XML, RDFa; local
file or http(s) URL, optionally .gz) against the SCHEMA-AP-NDE SHACL shapes, which are
fetched on every run, and writes a self-contained HTML report
(mh.nt -> mh.shacl.20261110-150312.html).

Options:
  -o, --output <file>      Output file (default: input name with its extension replaced
                           by .shacl.<YYYYMMDD-HHMMSS>.html, next to a local input, in
                           the current directory for a URL)
      --shapes <src>       Shapes file or URL, Turtle (default: SCHEMA-AP-NDE shacl.ttl
                           ${DEFAULT_SHAPES})
      --schema-https       Rewrite http://schema.org/ to https://schema.org/ before validating
      --max-per-error <n>  In reports with more than 50,000 results, list at most n
                           results per distinct error; counts stay exact (default 1000,
                           0 = list everything)
      --all-triples        Keep every statement in memory instead of only those the
                           shapes can look at (same results, much more memory)
  -t, --title <text>       Page title (default: "SCHEMA-AP-NDE SHACL Validation Report")
  -l, --lang <tag>         Preferred message language, e.g. nl (default: browser language)
  -h, --help               Show this help

Large dumps need more memory than Node allows by default, for example:
  NODE_OPTIONS=--max-old-space-size=24000 schema-ap-nde-shacl-html-cli dump.nt.gz`;

function fail(message) {
  console.error(`schema-ap-nde-shacl-html-cli: ${message}`);
  process.exit(1);
}

const log = (message) => console.error(message);
const fmt = (n) => n.toLocaleString('en');
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      shapes: { type: 'string' },
      'schema-https': { type: 'boolean' },
      'max-per-error': { type: 'string' },
      'all-triples': { type: 'boolean' },
      title: { type: 'string', short: 't' },
      lang: { type: 'string', short: 'l' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (error) {
  fail(`${error.message}\n\n${USAGE}`);
}

if (args.values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.positionals.length !== 1) fail(`expected exactly one input file or URL\n\n${USAGE}`);

const maxPerError = args.values['max-per-error'] === undefined ? 1000 : Number(args.values['max-per-error']);
if (!Number.isInteger(maxPerError) || maxPerError < 0) fail('--max-per-error expects a whole number, 0 or higher');

const input = args.positionals[0];
const output = args.values.output || defaultOutput(input);
const shapesSource = args.values.shapes || DEFAULT_SHAPES;

log(`Fetching shapes ${shapesSource} ...`);
let shapes;
try {
  shapes = await loadShapes(shapesSource);
} catch (error) {
  fail(`cannot load shapes ${shapesSource}: ${error.message}`);
}

// Only statements the shapes can look at are kept in memory, unless that is not safe
// for these shapes (sh:closed, SPARQL) or switched off.
const scope = args.values['all-triples'] ? null : shapeScope(shapes.store);
if (!scope && !args.values['all-triples']) log('The shapes use sh:closed or SPARQL: keeping all statements in memory.');

log(`Loading ${input} ...`);
const rewrite = Boolean(args.values['schema-https']);
let data;
try {
  data = await loadData(input, {
    keep: scope,
    rewrite,
    onProgress: (read) => { if (read % 5e6 === 0) log(`  ${fmt(read)} statements read (${elapsed()})`); },
  });
} catch (error) {
  fail(`cannot load ${input}: ${error.message}`);
}
if (!data.read) fail(`${input} contains no RDF statements`);
const rewritten = rewrite && data.legacy > 0;
if (rewritten) log(`Rewrote ${fmt(data.legacy)} http://schema.org/ statements to https://schema.org/.`);

log(scope
  ? `Validating ${fmt(data.kept)} of ${fmt(data.read)} statements (the rest cannot affect these shapes) ...`
  : `Validating ${fmt(data.read)} statements ...`);
let report;
try {
  report = await validate(data.store, shapes.store);
} catch (error) {
  fail(`validation failed: ${error.message}`);
}
log(`  ${fmt(report.results.length)} results (${elapsed()})`);

const targeted = hasTargets(data.store, shapes.store);
const model = buildModelFromResults(report.results, resultAdapter, shapes.prefixes, {
  source: sourceName(input),
  ...(isUrl(input) ? { sourceUrl: input } : {}),
  generated: new Date().toISOString(),
  triples: data.read,
  ...(scope ? { triplesKept: data.kept } : {}),
  shapes: { source: shapes.source, fetched: shapes.fetched, sha256: shapes.sha256 },
  engine: engineVersion(),
  conforms: report.conforms,
  schemaOrgHttp: data.legacy,
  schemaRewritten: rewritten,
  targeted,
  ...(args.values.title ? { title: args.values.title } : {}),
  ...(args.values.lang ? { lang: args.values.lang.toLowerCase() } : {}),
}, shapes.store, { maxPerError });

try {
  writeFileSync(output, renderHtml(model));
} catch (error) {
  fail(`cannot write ${output}: ${error.message}`);
}

if (data.legacy > 0 && !rewritten) {
  log(`Warning: ${fmt(data.legacy)} statements use http://schema.org/; the shapes only match https://schema.org/, so these were not checked. Use --schema-https to rewrite.`);
}
if (!targeted) log('Warning: no node in the data is a target of any shape; nothing was validated.');
if (model.meta.truncated) {
  log(`The report lists ${fmt(model.meta.count)} of ${fmt(model.meta.total)} results (at most ${fmt(model.meta.maxPerError)} per distinct error); all counts are exact.`);
}

const perSeverity = severityCounts(model).filter((s) => s.count > 0).map((s) => `${fmt(s.count)} ${s.label}`).join(', ');
const conforms = model.meta.conforms === null ? 'not stated' : String(model.meta.conforms);
log(`${output}: ${fmt(model.meta.total)} results${perSeverity ? ` (${perSeverity})` : ''}, conforms: ${conforms} (${elapsed()})`);
