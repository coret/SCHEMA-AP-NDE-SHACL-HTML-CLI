// SHACL validation results -> compact, dictionary-encoded JSON model.
// Follows https://www.w3.org/TR/shacl/#validation-report (section 3.6).

import { Parser, Store, DataFactory } from 'n3';

const { namedNode } = DataFactory;

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const DEFAULT_PREFIXES = { sh: SH, rdf: RDF, rdfs: RDFS, xsd: XSD };

// Row layout: [focus, severity, message, path, component, shape, value, details?, sourceConstraint?]
const SEV = 1, MSG = 2, PATH = 3, COMP = 4;

/** Parse Turtle (or N-Triples / TriG) into an n3 Store plus the declared prefixes. */
export function parseTurtle(text) {
  return new Promise((resolve, reject) => {
    const store = new Store();
    // blankNodePrefix '' keeps labels such as _:b0 as written in the source.
    new Parser({ blankNodePrefix: '' }).parse(text, (error, quad, prefixes) => {
      if (error) return reject(error);
      if (quad) return store.addQuad(quad);
      const declared = {};
      for (const [name, ns] of Object.entries(prefixes || {})) {
        declared[name] = typeof ns === 'string' ? ns : ns.value;
      }
      resolve({ store, prefixes: declared });
    });
  });
}

function makeDict() {
  const index = new Map();
  const list = [];
  return {
    list,
    add(key, makeEntry) {
      let i = index.get(key);
      if (i === undefined) {
        i = list.length;
        index.set(key, i);
        list.push(makeEntry());
      }
      return i;
    },
  };
}

function localName(iri) {
  const m = /[#/]([^#/]*)$/.exec(iri);
  return m && m[1] ? m[1] : iri;
}

const groupKey = (row) => `${row[SEV]}|${row[MSG]}|${row[PATH]}|${row[COMP]}`;
const focusKey = (term) => (term == null ? '' : typeof term === 'string' ? `i${term}` : `l${term[0]}`);

/**
 * Shared machinery for turning validation results (as RDF) into model rows.
 * `shapes` (optional n3 Store with the shapes graph) is used to give source shapes a name.
 */
function createBuilder(declaredPrefixes = {}, shapes = null) {
  const prefixes = { ...declaredPrefixes };
  const namespaces = new Set(Object.values(prefixes));
  for (const [name, ns] of Object.entries(DEFAULT_PREFIXES)) {
    if (!(name in prefixes) && !namespaces.has(ns)) prefixes[name] = ns;
  }
  delete prefixes['']; // the empty prefix reads poorly in a report (":foo")
  const byLength = Object.entries(prefixes).sort((a, b) => b[1].length - a[1].length);

  const curie = (iri) => {
    for (const [name, ns] of byLength) {
      if (ns && iri.startsWith(ns)) {
        const local = iri.slice(ns.length);
        if (/^[\w\-.%]*$/.test(local)) return `${name}:${local}`;
      }
    }
    return iri;
  };

  const objects = (store, subject, predicate) => store.getObjects(subject, namedNode(predicate), null);
  const first = (store, subject, predicate) => objects(store, subject, predicate)[0];

  // IRI -> "iri", blank node -> "_:label", literal -> [value] | [value, "@lang"] | [value, "datatype"]
  const encodeTerm = (term) => {
    if (!term) return null;
    if (term.termType === 'NamedNode') return term.value;
    if (term.termType === 'BlankNode') return `_:${term.value}`;
    if (term.language) return [term.value, `@${term.language}`];
    const datatype = term.datatype && term.datatype.value;
    if (datatype && datatype !== `${XSD}string`) return [term.value, curie(datatype)];
    return [term.value];
  };

  const readList = (store, head) => {
    const items = [];
    const seen = new Set();
    let node = head;
    while (node && node.value !== `${RDF}nil` && !seen.has(node.id)) {
      seen.add(node.id);
      const item = first(store, node, `${RDF}first`);
      if (item) items.push(item);
      node = first(store, node, `${RDF}rest`);
    }
    return items;
  };

  // SHACL property path -> SPARQL-like text. prec: 3 atom, 2 unary, 1 sequence, 0 alternative.
  const pathExpr = (store, term, depth = 0) => {
    if (term.termType === 'NamedNode') return { text: curie(term.value), prec: 3 };
    if (term.termType !== 'BlankNode' || depth > 20) return { text: String(term.value), prec: 3 };
    const wrap = (e, min) => (e.prec < min ? `(${e.text})` : e.text);
    const sub = (p) => first(store, term, SH + p);
    const next = (t) => pathExpr(store, t, depth + 1);
    let t;
    if ((t = sub('inversePath'))) return { text: `^${wrap(next(t), 3)}`, prec: 2 };
    if ((t = sub('alternativePath'))) {
      return { text: readList(store, t).map((item) => next(item).text).join('|'), prec: 0 };
    }
    if ((t = sub('zeroOrMorePath'))) return { text: `${wrap(next(t), 3)}*`, prec: 2 };
    if ((t = sub('oneOrMorePath'))) return { text: `${wrap(next(t), 3)}+`, prec: 2 };
    if ((t = sub('zeroOrOnePath'))) return { text: `${wrap(next(t), 3)}?`, prec: 2 };
    if (first(store, term, `${RDF}first`)) {
      return { text: readList(store, term).map((item) => wrap(next(item), 1)).join('/'), prec: 1 };
    }
    return { text: `_:${term.value}`, prec: 3 };
  };

  const dict = {
    severity: makeDict(),
    path: makeDict(),
    component: makeDict(),
    shape: makeDict(),
    message: makeDict(),
  };

  const severityIndex = (term) => {
    const iri = term && term.termType === 'NamedNode' ? term.value : `${SH}Violation`; // spec default
    // sh:Violation is displayed as "Error"; the IRI is kept as is.
    const label = iri === `${SH}Violation` ? 'Error' : localName(iri);
    return dict.severity.add(iri, () => ({ iri, label }));
  };

  // The three standard severities always exist (indexes 0, 1, 2), so the page can show
  // a chip for each of them even when the report has no such results.
  for (const name of ['Violation', 'Warning', 'Info']) severityIndex(namedNode(SH + name));

  const pathIndex = (store, term) => {
    if (!term) return -1;
    const { text } = pathExpr(store, term);
    return dict.path.add(text, () =>
      (term.termType === 'NamedNode' ? { label: text, iri: term.value } : { label: text }));
  };

  const componentIndex = (term) => {
    if (!term) return -1;
    return dict.component.add(term.id, () =>
      (term.termType === 'NamedNode'
        ? { label: curie(term.value), iri: term.value }
        : { label: `_:${term.value}` }));
  };

  // Name of a shape: its own sh:name / rdfs:label, else that of the node shape it is a
  // property shape of (the path is a column of its own), else a hand-written blank node label.
  const shapeName = (store, term) => {
    const graph = shapes || store;
    const own = (node) => {
      const literal = first(graph, node, `${SH}name`) || first(graph, node, `${RDFS}label`);
      return literal ? literal.value : null;
    };
    const fallback = (node) => (node.termType === 'NamedNode' ? curie(node.value)
      : /^(n3-|b)\d+$/.test(node.value) ? null : node.value);
    const name = own(term);
    if (name) return name;
    const parent = graph.getSubjects(namedNode(`${SH}property`), term, null)[0];
    if (parent) return own(parent) || fallback(parent);
    return term.termType === 'BlankNode' && shapes ? fallback(term) : null;
  };

  const shapeIndex = (store, term) => {
    if (!term) return -1;
    return dict.shape.add(term.id, () => {
      const entry = term.termType === 'NamedNode'
        ? { id: term.value, label: curie(term.value) }
        : { id: `_:${term.value}`, label: `_:${term.value}` };
      const name = shapeName(store, term);
      if (name) entry.name = name;
      return entry;
    });
  };

  const messageIndex = (terms) => {
    if (!terms.length) return -1;
    const byLang = {};
    for (const term of terms) {
      const lang = term.language || '';
      byLang[lang] = lang in byLang ? `${byLang[lang]}\n${term.value}` : term.value;
    }
    const key = JSON.stringify(Object.keys(byLang).sort().map((lang) => [lang, byLang[lang]]));
    return dict.message.add(key, () => byLang);
  };

  /** One sh:ValidationResult node in `store` -> row. */
  const row = (store, node, ancestors = new Set([node.id])) => {
    const out = [
      encodeTerm(first(store, node, `${SH}focusNode`)),
      severityIndex(first(store, node, `${SH}resultSeverity`)),
      messageIndex(objects(store, node, `${SH}resultMessage`)),
      pathIndex(store, first(store, node, `${SH}resultPath`)),
      componentIndex(first(store, node, `${SH}sourceConstraintComponent`)),
      shapeIndex(store, first(store, node, `${SH}sourceShape`)),
      encodeTerm(first(store, node, `${SH}value`)),
    ];
    const details = objects(store, node, `${SH}detail`)
      .filter((d) => !ancestors.has(d.id))
      .map((d) => row(store, d, new Set(ancestors).add(d.id)));
    const sourceConstraint = encodeTerm(first(store, node, `${SH}sourceConstraint`));
    if (details.length || sourceConstraint) out.push(details.length ? details : null);
    if (sourceConstraint) out.push(sourceConstraint);
    return out;
  };

  /**
   * Assemble the model. `groups` maps a group key to { row, n, focus } with exact totals;
   * when omitted the totals are taken from `rows` (nothing was left out).
   */
  const finish = (meta, rows, groups = null) => {
    if (!groups) {
      groups = new Map();
      for (const r of rows) {
        const key = groupKey(r);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { row: r, n: 0, focus: new Set() }));
        g.n++;
        g.focus.add(focusKey(r[0]));
      }
    }
    // Summary entry: [severity, message, path, component, results, distinct focus nodes]
    const summary = [...groups.values()].map((g) => [g.row[SEV], g.row[MSG], g.row[PATH], g.row[COMP], g.n, g.focus.size]);
    const total = summary.reduce((sum, g) => sum + g[4], 0);
    return {
      meta: { ...meta, total, count: rows.length, truncated: rows.length < total },
      prefixes,
      dict: {
        severity: dict.severity.list,
        path: dict.path.list,
        component: dict.component.list,
        shape: dict.shape.list,
        message: dict.message.list,
      },
      summary,
      results: rows,
    };
  };

  return { row, finish };
}

/** Build the JSON model from a SHACL report graph. `meta` is merged into `model.meta`. */
export function buildModel(store, declaredPrefixes = {}, meta = {}, shapes = null) {
  const builder = createBuilder(declaredPrefixes, shapes);

  // Top-level results: objects of sh:result, plus typed results that are not nested via sh:detail.
  const top = [];
  const seen = new Set();
  const addTop = (term) => {
    if (term.termType === 'Literal' || seen.has(term.id)) return;
    seen.add(term.id);
    top.push(term);
  };
  for (const quad of store.getQuads(null, namedNode(`${SH}result`), null, null)) addTop(quad.object);
  const nested = new Set(store.getObjects(null, namedNode(`${SH}detail`), null).map((t) => t.id));
  for (const subject of store.getSubjects(namedNode(`${RDF}type`), namedNode(`${SH}ValidationResult`), null)) {
    if (!nested.has(subject.id)) addTop(subject);
  }
  const rows = top.map((term) => builder.row(store, term));

  // sh:conforms: false if any report says false, true if all say true, null if absent.
  const boolOf = (predicate) => {
    const values = store.getObjects(null, namedNode(predicate), null).map((t) => t.value);
    if (!values.length) return null;
    return values.every((v) => v === 'true' || v === '1');
  };

  return builder.finish({
    ...meta,
    conforms: boolOf(`${SH}conforms`),
    shapesGraphWellFormed: boolOf(`${SH}shapesGraphWellFormed`),
  }, rows);
}

/**
 * Build the JSON model straight from a validation engine's result objects, without first
 * materialising the whole report as RDF (a large dump can give millions of results).
 *
 * `adapter.toStore(result)` returns `{ store, node }` with that single result as RDF,
 * `adapter.key(result)` a cheap string that is equal for results of the same error, and
 * `adapter.focus(result)` a string identifying the focus node.
 *
 * Totals per error are always exact. When the report has more than `capAbove` results,
 * at most `maxPerError` rows per distinct error are kept in the list (0 = keep all).
 */
export function buildModelFromResults(results, adapter, declaredPrefixes = {}, meta = {}, shapes = null,
  { maxPerError = 1000, capAbove = 50000 } = {}) {
  const builder = createBuilder(declaredPrefixes, shapes);
  const cap = maxPerError > 0 && results.length > capAbove ? maxPerError : Infinity;
  const groups = new Map(); // group key -> { row, n, focus, listed }
  const byKey = new Map(); // adapter key -> group, for results beyond the cap
  const rows = [];

  for (const result of results) {
    const key = adapter.key(result);
    let group = byKey.get(key);
    if (!group || group.listed < cap) {
      const { store, node } = adapter.toStore(result);
      const r = builder.row(store, node);
      const gk = groupKey(r);
      group = groups.get(gk);
      if (!group) groups.set(gk, (group = { row: r, n: 0, focus: new Set(), listed: 0 }));
      byKey.set(key, group);
      if (group.listed < cap) {
        rows.push(r);
        group.listed++;
      }
    }
    group.n++;
    group.focus.add(adapter.focus(result));
  }

  return builder.finish({
    ...meta,
    shapesGraphWellFormed: null,
    ...(Number.isFinite(cap) ? { maxPerError: cap } : {}),
  }, rows, groups);
}

/** Turtle text of a SHACL report -> JSON model. */
export async function parseReport(text, meta = {}) {
  const { store, prefixes } = await parseTurtle(text);
  return buildModel(store, prefixes, meta);
}

/** Exact result counts per severity label, most severe first. */
export function severityCounts(model) {
  const counts = model.dict.severity.map((s) => ({ label: s.label, iri: s.iri, count: 0 }));
  for (const group of model.summary) counts[group[0]].count += group[4];
  const rank = (iri) => {
    const i = [`${SH}Violation`, `${SH}Warning`, `${SH}Info`].indexOf(iri);
    return i < 0 ? 3 : i;
  };
  return counts.sort((a, b) => rank(a.iri) - rank(b.iri));
}
