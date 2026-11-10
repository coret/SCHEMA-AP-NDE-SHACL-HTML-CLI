import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultOutput, loadData, loadShapes, shapeScope, sourceName, timestamp } from '../lib/load.js';
import { buildModelFromResults, parseTurtle, severityCounts } from '../lib/parse.js';
import { hasTargets, resultAdapter, validate } from '../lib/validate.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));

// The five results Apache Jena 5.6.0 gives for fixtures/data.* against fixtures/shapes.ttl.
const EXPECTED = [
  'http://example.org/bad | schema:associatedMedia | Error | sh:OrConstraintComponent',
  'http://example.org/bad | schema:associatedMedia | Warning | sh:QualifiedMinCountConstraintComponent',
  'http://example.org/bad | schema:name | Error | sh:MinCountConstraintComponent',
  'http://example.org/m2 | schema:contentUrl | Error | sh:NodeConstraintComponent',
  'http://example.org/m2 | schema:license | Error | sh:MinCountConstraintComponent',
];

const describe = (model) => model.results.map((r) => [
  r[0], model.dict.path[r[3]].label, model.dict.severity[r[1]].label, model.dict.component[r[4]].label,
].join(' | ')).sort();

async function run(dataFile, loadOptions = {}, modelOptions = {}) {
  const shapes = await loadShapes(fixture('shapes.ttl'));
  const scope = 'keep' in loadOptions ? loadOptions.keep : shapeScope(shapes.store);
  const data = await loadData(dataFile, { ...loadOptions, keep: scope });
  const report = await validate(data.store, shapes.store);
  const model = buildModelFromResults(report.results, resultAdapter, shapes.prefixes,
    { conforms: report.conforms }, shapes.store, modelOptions);
  return { data, shapes, report, model };
}

test('Turtle, JSON-LD, RDF/XML and gzipped Turtle give the results Jena gives', async () => {
  for (const name of ['data.ttl', 'data.jsonld', 'data.rdf', 'data.ttl.gz']) {
    const { model, data } = await run(fixture(name));
    assert.deepEqual(describe(model), EXPECTED, name);
    assert.equal(data.read, 10, `${name}: statements read`);
    assert.equal(data.kept, 8, `${name}: the two ex:note statements are not kept`);
    assert.equal(model.meta.conforms, false);
    assert.equal(model.meta.total, 5);
    assert.equal(model.meta.truncated, false);
  }
});

test('regression: value-level results survive the shacl-engine result cache', async () => {
  // Without the Shape.validate replacement in lib/validate.js, shacl-engine 1.1.3 drops this one.
  const { model } = await run(fixture('data.ttl'));
  const row = model.results.find((r) => r[0] === 'http://example.org/m2' && model.dict.path[r[3]].label === 'schema:contentUrl');
  assert.ok(row, 'the literal contentUrl is reported');
  assert.deepEqual(row[6], ['https://example.org/m2.jpg']);
  assert.deepEqual(model.dict.message[row[2]], { en: 'Use a web URI', nl: 'Gebruik een web-URI' });
});

test('keeping all statements gives the same results as the predicate filter', async () => {
  const { model, data } = await run(fixture('data.ttl'), { keep: null });
  assert.deepEqual(describe(model), EXPECTED);
  assert.equal(data.kept, 10);
});

test('shapeScope lists the predicates the shapes can look at, or null when unsafe', async () => {
  const shapes = await loadShapes(fixture('shapes.ttl'));
  assert.deepEqual([...shapeScope(shapes.store)].sort(), [
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    'http://www.w3.org/2000/01/rdf-schema#subClassOf',
    'https://schema.org/associatedMedia',
    'https://schema.org/contentUrl',
    'https://schema.org/license',
    'https://schema.org/name',
  ]);
  const P = '@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://example.org/> .\n';
  const scopeOf = async (ttl) => shapeScope((await parseTurtle(P + ttl)).store);
  assert.deepEqual([...await scopeOf('ex:S sh:targetObjectsOf ex:t ; sh:property [ sh:path ( ex:a [ sh:inversePath ex:b ] ) ; sh:lessThan ex:c ] .')]
    .filter((p) => p.startsWith('http://example.org/')).sort(),
  ['http://example.org/a', 'http://example.org/b', 'http://example.org/c', 'http://example.org/t']);
  assert.equal(await scopeOf('ex:S sh:targetClass ex:C ; sh:closed true .'), null);
  assert.equal(await scopeOf('ex:S sh:targetClass ex:C ; sh:sparql [ sh:select "SELECT $this WHERE {}" ] .'), null);
});

test('shape names come from the shapes graph', async () => {
  const { model } = await run(fixture('data.ttl'));
  const nameOf = (path, component) => {
    const row = model.results.find((r) => model.dict.path[r[3]].label === path && model.dict.component[r[4]].label === component);
    return model.dict.shape[row[5]].name;
  };
  assert.equal(nameOf('schema:name', 'sh:MinCountConstraintComponent'), 'CreativeWork');
  assert.equal(nameOf('schema:contentUrl', 'sh:NodeConstraintComponent'), 'MediaObject');
});

test('http://schema.org/ data: counted, not matched, and matched after rewriting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shacl-report-'));
  const legacy = join(dir, 'legacy.ttl');
  const text = readFileSync(fixture('data.ttl'), 'utf8').replace('<https://schema.org/>', '<http://schema.org/>');
  (await import('node:fs')).writeFileSync(legacy, text);

  const asIs = await run(legacy);
  assert.equal(asIs.data.legacy, 8);
  assert.equal(asIs.model.meta.total, 0);
  assert.equal(hasTargets(asIs.data.store, asIs.shapes.store), false, 'nothing is targeted');

  const rewritten = await run(legacy, { rewrite: true });
  assert.equal(rewritten.data.legacy, 8);
  assert.deepEqual(describe(rewritten.model), EXPECTED);
  assert.equal(hasTargets(rewritten.data.store, rewritten.shapes.store), true);
});

test('a long report keeps exact counts but lists a limited number of results per error', async () => {
  const { report, shapes } = await run(fixture('data.ttl'));
  const many = [];
  for (let i = 0; i < 40; i++) many.push(...report.results);
  const model = buildModelFromResults(many, resultAdapter, shapes.prefixes, {}, shapes.store, { maxPerError: 3, capAbove: 100 });
  assert.equal(model.meta.total, 200);
  assert.equal(model.meta.count, 15, '5 distinct errors, 3 listed each');
  assert.equal(model.meta.truncated, true);
  assert.equal(model.meta.maxPerError, 3);
  assert.deepEqual(model.summary.map((g) => g[4]), [40, 40, 40, 40, 40]);
  assert.deepEqual(model.summary.map((g) => g[5]), [1, 1, 1, 1, 1], 'distinct focus nodes');
  assert.deepEqual(severityCounts(model).map((s) => [s.label, s.count]), [['Error', 160], ['Warning', 40], ['Info', 0]]);

  const below = buildModelFromResults(many, resultAdapter, shapes.prefixes, {}, shapes.store, { maxPerError: 3, capAbove: 1000 });
  assert.equal(below.meta.count, 200, 'below the threshold everything is listed');
  const unlimited = buildModelFromResults(many, resultAdapter, shapes.prefixes, {}, shapes.store, { maxPerError: 0, capAbove: 100 });
  assert.equal(unlimited.meta.truncated, false);
});

test('default output name', () => {
  const when = new Date(2026, 10, 10, 15, 3, 12);
  assert.equal(timestamp(when), '20261110-150312');
  assert.equal(defaultOutput('/data/mh.nt', when), '/data/mh.shacl.20261110-150312.html');
  assert.equal(defaultOutput('dump.nt.gz', when), 'dump.shacl.20261110-150312.html');
  assert.equal(defaultOutput('notes.rdfdata', when), 'notes.rdfdata.shacl.20261110-150312.html');
  assert.equal(defaultOutput('https://example.org/files/gouda.nt.gz?x=1', when), 'gouda.shacl.20261110-150312.html');
  assert.equal(defaultOutput('https://example.org/', when), 'example.org.shacl.20261110-150312.html');
  assert.equal(sourceName('https://example.org/a/b%20c.ttl'), 'b c.ttl');
});

test('loading fails clearly', async () => {
  await assert.rejects(loadShapes(fixture('missing.ttl')));
  await assert.rejects(loadData(fixture('missing.nt')));
  await assert.rejects(loadData(fixture('missing.jsonld')));
});

test('CLI writes a timestamped report next to the input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shacl-report-'));
  const data = join(dir, 'sample.ttl');
  (execFileSync('cp', [fixture('data.ttl'), data]));
  const stdout = execFileSync(process.execPath, [cli, data, '--shapes', fixture('shapes.ttl')], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  assert.equal(stdout, '', 'progress goes to stderr, nothing to stdout');
  const [name] = readdirSync(dir).filter((f) => f.endsWith('.html'));
  assert.match(name, /^sample\.shacl\.\d{8}-\d{6}\.html$/);
  const html = readFileSync(join(dir, name), 'utf8');
  const model = JSON.parse(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(model.meta.total, 5);
  assert.equal(model.meta.source, 'sample.ttl');
  assert.equal(model.meta.triples, 10);
  assert.equal(model.meta.triplesKept, 8);
  assert.match(model.meta.engine, /^shacl-engine 1\.1\.3$/);
});
