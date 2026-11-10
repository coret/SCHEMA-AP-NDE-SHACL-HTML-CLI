// SHACL validation with shacl-engine.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PathList } from 'grapoi';
import { DataFactory, Store } from 'n3';
import rdf from 'rdf-ext';
import { Validator } from 'shacl-engine';
import Context from 'shacl-engine/lib/Context.js';
import Result from 'shacl-engine/lib/Result.js';
import Shape from 'shacl-engine/lib/Shape.js';

const { namedNode } = DataFactory;

// Two changes to shacl-engine 1.1.3 internals. The version is pinned in package.json;
// test/validate.test.js has a regression test for the first one.
//
// 1. Result cache bug. Shape.validate() remembers which (shape, focus node) pairs were
//    validated, but looks the remembered results up under a different key than the one
//    they were stored under (the key of a value-level result includes the value path).
//    When a property shape is first evaluated in a nested context (sh:or, sh:node,
//    sh:qualifiedValueShape) and later directly from a target shape, its value-level
//    results were dropped: violations went missing compared with Apache Jena. The
//    replacement replays exactly the results the first evaluation added to the report.
//
// 2. Unbounded bookkeeping. The engine keeps one Set entry per evaluated (shape, node)
//    and one Map entry per result for the whole run. A JavaScript Map or Set holds at
//    most 2^24 entries, so a dump with a million target nodes failed with "Map maximum
//    size exceeded". Memoisation is only an optimisation, so the memo below is emptied
//    when it grows large; the guard against recursive shapes (`active`) only holds the
//    evaluations that are in progress. Context.result() no longer fills the engine's own
//    per-result Map, which nothing reads any more.
const MEMO_LIMIT = 500000;
const runs = new WeakMap(); // context.processed (one per validation run) -> { memo, active }
Shape.prototype.validate = async function validateShape(context) {
  let run = runs.get(context.processed);
  if (!run) runs.set(context.processed, (run = { memo: new Map(), active: new Set() }));
  const id = context.id({ shape: this });
  const known = run.memo.get(id);
  if (known) {
    for (const result of known) context.report.results.push(result);
    return context;
  }
  if (run.active.has(id)) return context; // recursive shape: contribute nothing
  run.active.add(id);
  const start = context.report.results.length;
  try {
    await this.shapeValidator.validate(context);
  } finally {
    run.active.delete(id);
  }
  if (run.memo.size >= MEMO_LIMIT) run.memo.clear();
  run.memo.set(id, context.report.results.slice(start));
  return context;
};
Context.prototype.result = function result(args) {
  this.report.results.push(new Result({
    factory: this.factory,
    focusNode: this.focusNode,
    shape: this.shape,
    value: this.value,
    valuePaths: this.valuePaths,
    ...args,
  }));
};
const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

/**
 * Validate an RDF/JS dataset against a shapes dataset. Returns the engine's result objects
 * (not an RDF report: a large dump can give millions of results) and sh:conforms.
 */
export async function validate(data, shapes) {
  const validator = new Validator(shapes, { factory: rdf });
  const report = await validator.validate({ dataset: data });
  return { results: report.results, conforms: report.conforms };
}

const RESULT_TYPE = namedNode(`${SH}ValidationResult`);

/** Adapter that lets lib/parse.js read shacl-engine result objects (see buildModelFromResults). */
export const resultAdapter = {
  // Results of one shape, component and severity are one error; a path that differs from
  // the shape's own path (rare) is added to tell them apart.
  key(result) {
    const own = result.path === result.shape.path ? ''
      : JSON.stringify((result.path || []).map((step) => [step.quantifier, step.start, step.predicates.map((p) => p.value)]));
    return `${result.shape.ptr.term.value}|${result.constraintComponent.value}|${result.severity.value}|${own}`;
  },
  focus(result) {
    const term = result.focusNode.term;
    return term.termType.charAt(0) + term.value;
  },
  // The single result as a small RDF graph, exactly as the engine would put it in a report.
  toStore(result) {
    const ptr = new PathList({ dataset: rdf.dataset(), factory: rdf, terms: [rdf.blankNode()] });
    result.build(ptr, {});
    const store = new Store([...ptr.dataset]);
    return { store, node: store.getSubjects(RDF_TYPE, RESULT_TYPE, null)[0] };
  },
};

/**
 * True when at least one node in the data is a target of some shape (sh:targetClass,
 * sh:targetNode, sh:targetSubjectsOf, sh:targetObjectsOf). Without any target an empty
 * report says nothing about the data. Subclass reasoning is not applied.
 */
export function hasTargets(data, shapes) {
  const objects = (p) => shapes.getObjects(null, namedNode(SH + p), null);
  for (const cls of objects('targetClass')) {
    if (data.countQuads(null, RDF_TYPE, cls, null)) return true;
  }
  for (const predicate of objects('targetSubjectsOf').concat(objects('targetObjectsOf'))) {
    if (data.countQuads(null, predicate, null, null)) return true;
  }
  for (const node of objects('targetNode')) {
    if (data.countQuads(node, null, null, null) || data.countQuads(null, null, node, null)) return true;
  }
  return false;
}

/** "shacl-engine 1.1.3", for the report footer. */
export function engineVersion() {
  try {
    const entry = createRequire(import.meta.url).resolve('shacl-engine');
    const { version } = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'));
    return `shacl-engine ${version}`;
  } catch {
    return 'shacl-engine';
  }
}
