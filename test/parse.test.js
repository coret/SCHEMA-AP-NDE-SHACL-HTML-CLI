import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReport, severityCounts } from '../lib/parse.js';
import { renderHtml, embedJson } from '../lib/render.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SH = 'http://www.w3.org/ns/shacl#';

// Row layout: [focus, severity, message, path, component, shape, value, details?, sourceConstraint?]
const [FOCUS, SEV, MSG, PATH, COMP, SHAPE, VALUE, DETAILS, CONSTRAINT] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

test('Jena style nested report', async () => {
  const model = await parseReport(fixture('jena.shacl.ttl'), { source: 'jena.shacl.ttl' });
  assert.equal(model.meta.count, 2);
  assert.equal(model.meta.conforms, false);
  assert.equal(model.meta.source, 'jena.shacl.ttl');
  assert.deepEqual(model.dict.severity.map((s) => s.label), ['Error', 'Warning', 'Info'],
    'standard severities are always present');
  assert.equal(model.dict.severity[1].iri, `${SH}Warning`);
  assert.deepEqual(severityCounts(model).map((s) => s.count), [0, 2, 0]);
  assert.deepEqual(model.dict.path, [{ label: 'schema:associatedMedia', iri: 'https://schema.org/associatedMedia' }]);
  assert.equal(model.dict.component[0].label, 'sh:QualifiedMinCountConstraintComponent');
  assert.deepEqual(model.dict.shape, [{ id: '_:b0', label: '_:b0' }]);
  assert.equal(model.dict.message.length, 1, 'identical message sets share one entry');
  assert.deepEqual(Object.keys(model.dict.message[0]).sort(), ['en', 'nl']);
  assert.match(model.dict.message[0].nl, /^Voeg minimaal één/);
  assert.equal(model.results[0][FOCUS], 'http://data.bibliotheken.nl/id/mh/m991006537959707151');
  assert.equal(model.results[0][VALUE], null);
  assert.equal(model.results[0].length, 7);
});

test('flat report: severities, paths, values, details', async () => {
  const model = await parseReport(fixture('mixed.shacl.ttl'));
  const byFocusAndComp = (focus, comp) => model.results.find((r) =>
    r[FOCUS] === focus && model.dict.component[r[COMP]].label === comp);
  const sev = (r) => model.dict.severity[r[SEV]].label;
  const path = (r) => (r[PATH] < 0 ? null : model.dict.path[r[PATH]].label);

  assert.equal(model.meta.count, 5, 'the sh:detail result is not a top-level result');

  const r1 = byFocusAndComp('http://example.org/a', 'sh:MinLengthConstraintComponent');
  assert.equal(sev(r1), 'Error');
  assert.equal(path(r1), 'schema:name');
  assert.deepEqual(r1[VALUE], ['x </script><b>bold</b>', '@en']);
  assert.deepEqual(model.dict.shape[r1[SHAPE]], { id: 'http://example.org/NameShape', label: 'ex:NameShape', name: 'Name shape' });

  const r2 = byFocusAndComp('http://example.org/a', 'sh:MaxCountConstraintComponent');
  assert.equal(sev(r2), 'Error', 'missing sh:resultSeverity defaults to sh:Violation');
  assert.equal(r2[MSG], -1);
  assert.equal(path(r2), '^schema:isPartOf');
  assert.deepEqual(r2[VALUE], ['42', 'xsd:integer']);

  const r3 = byFocusAndComp('http://example.org/b', 'sh:NodeConstraintComponent');
  assert.equal(sev(r3), 'Warning');
  assert.equal(path(r3), 'schema:author/schema:name');
  assert.equal(r3[DETAILS].length, 1);
  assert.equal(r3[DETAILS][0][FOCUS], 'http://example.org/author1');
  assert.equal(sev(r3[DETAILS][0]), 'Info');

  const r4 = byFocusAndComp('http://example.org/b', 'sh:MinLengthConstraintComponent');
  assert.equal(path(r4), 'schema:name|schema:alternateName*');
  assert.equal(r4[MSG], r1[MSG], 'same messages in another order share one entry');

  const r5 = model.results.find((r) => r[FOCUS] === '_:thing');
  assert.equal(sev(r5), 'Notice');
  assert.equal(path(r5), null);
  assert.deepEqual(model.dict.message[r5[MSG]], { '': 'Untagged message' });
  assert.equal(r5[DETAILS], null);
  assert.equal(r5[CONSTRAINT], 'http://example.org/sparqlConstraint');

  assert.deepEqual(severityCounts(model).map((s) => [s.label, s.count]),
    [['Error', 2], ['Warning', 1], ['Info', 1], ['Notice', 1]]);
});

test('path precedence gets parentheses', async () => {
  const model = await parseReport(`
    @prefix sh: <http://www.w3.org/ns/shacl#> .
    @prefix ex: <http://example.org/> .
    [] a sh:ValidationResult ; sh:focusNode ex:a ;
       sh:resultPath ( ex:p [ sh:alternativePath ( ex:q ex:r ) ] [ sh:oneOrMorePath ( ex:s ex:t ) ] ) .`);
  assert.equal(model.dict.path[0].label, 'ex:p/(ex:q|ex:r)/(ex:s/ex:t)+');
  assert.equal(model.meta.conforms, null);
});

test('empty conforming report', async () => {
  const model = await parseReport('@prefix sh: <http://www.w3.org/ns/shacl#> . [] a sh:ValidationReport ; sh:conforms true .');
  assert.equal(model.meta.count, 0);
  assert.equal(model.meta.conforms, true);
  assert.match(renderHtml(model), /<title>SCHEMA-AP-NDE SHACL Validation Report<\/title>/);
});

test('invalid Turtle is rejected', async () => {
  await assert.rejects(parseReport('this is not turtle'));
});

test('embedded JSON cannot break out of the script element', async () => {
  const model = await parseReport(fixture('mixed.shacl.ttl'), { title: 'A <b>title</b> {{DATA}}' });
  const html = renderHtml(model);
  assert.equal(html.match(/<\/script>/g).length, 3, 'only the three template script elements are closed');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('<title>A &#60;b&#62;title&#60;/b&#62; {{DATA}}</title>'));
  const json = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(model)), 'data survives the round trip');
  assert.equal(embedJson(String.fromCharCode(0x2028) + "<&>"), "\"\\u2028\\u003c\\u0026\\u003e\"");
});
