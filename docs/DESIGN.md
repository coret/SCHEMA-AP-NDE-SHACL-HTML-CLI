# SCHEMA-AP-NDE-SHACL-HTML-CLI: design and validation notes

Validates RDF data against the [SCHEMA-AP-NDE](https://docs.nde.nl/schema-profile/) SHACL shapes and writes the outcome as one self-contained HTML page: a summary per error and a filterable, sortable, paginated results table.

```
node cli.js mh.nt
# -> mh.shacl.20261110-150312.html next to the input
node cli.js https://www.goudatijdmachine.nl/omeka/files/goudatijdmachine.nt.gz
```

The shapes are fetched on every run from
https://raw.githubusercontent.com/netwerk-digitaal-erfgoed/schema-profile/refs/heads/main/shacl.ttl (no local copy, no cache). The page has no external dependencies: CSS, JavaScript and the results (as JSON) are inline, so the file can be mailed, archived or opened from disk.

## Install

Requires Node.js 20 or newer. No Java, no Jena.

```
npm install
```

## Usage

```
schema-ap-nde-shacl-html-cli <file-or-url> [options]

  -o, --output <file>      Output file (default: input name with its extension replaced
                           by .shacl.<YYYYMMDD-HHMMSS>.html, next to a local input, in
                           the current directory for a URL)
      --shapes <src>       Shapes file or URL, Turtle (default: SCHEMA-AP-NDE shacl.ttl)
      --schema-https       Rewrite http://schema.org/ to https://schema.org/ before validating
      --max-per-error <n>  In reports with more than 50,000 results, list at most n
                           results per distinct error; counts stay exact (default 1000,
                           0 = list everything)
      --all-triples        Keep every statement in memory instead of only those the
                           shapes can look at (same results, much more memory)
  -t, --title <text>       Page title (default: "SCHEMA-AP-NDE SHACL Validation Report")
  -l, --lang <tag>         Preferred message language, e.g. nl (default: browser language)
  -h, --help               Show help
```

Input: Turtle, N-Triples, N-Quads, TriG, JSON-LD, RDF/XML or RDFa, as a local file or an
http(s) URL, optionally gzipped (`.gz`). The timestamp in the output name is local time.

Progress and a one-line summary go to stderr, nothing to stdout:

```
Fetching shapes https://raw.githubusercontent.com/.../shacl.ttl ...
Loading mh.nt ...
Validating 64,545 of 92,233 statements (the rest cannot affect these shapes) ...
  1,351 results (2.0s)
mh.shacl.20261110-150312.html: 1,351 results (1,351 Warning), conforms: false (2.1s)
```

Exit code 0 means the report was written, whatever the outcome of the validation. 1 means
a usage, load, shapes-fetch, parse, validation or write error. When the shapes cannot be
fetched the run fails; there is no cached fallback.

Large dumps need more memory than Node allows by default:

```
NODE_OPTIONS=--max-old-space-size=24000 node cli.js dump.nt.gz
```

## What the page offers

- Overview: source (a link when it was a URL), statements read and how many of them the
  shapes can look at, number of results. A "Conforms" badge only when `sh:conforms` is
  true and something was actually validated.
- Notices when the outcome needs a caveat: data in the legacy `http://schema.org/`
  namespace, no node targeted by any shape ("Nothing was validated"), a shortened list.
- Severity chips with counts. `Error` (`sh:Violation`), `Warning` and `Info` are always
  shown, also with a count of 0; a custom severity gets a chip when the shapes use it.
  Select one or more to filter; none selected means all.
- Errors table: one row per distinct combination of severity, message, path and
  constraint component, with the number of results and of distinct focus nodes. Select a
  row to filter the results on that error, select it again to clear.
- Filters on message, path and constraint component, plus a text search on focus node
  and value. The counts in every filter take the other active filters into account.
- Results table: sortable columns, 50/100/500 rows per page. Columns that are empty in
  the whole report (often `Value`) are left out. The Shape column shows the name of the
  node shape (`sh:name`, for example "CreativeWork").
- Language switch for messages (the NDE shapes have Dutch and English messages).
- The filter state lives in the URL fragment (`#sev=0&msg=2&page=3`), so a filtered view
  can be bookmarked or shared together with the file.
- Download of the listed, filtered rows as CSV and of the full data as JSON.
- Light and dark theme with a switch in the header. It starts from the system setting; a
  choice made with the switch is remembered in the browser (`localStorage`). Usable on a
  phone, print style (always light).
- Footer: generation time, engine version, shapes source with fetch time and the first
  12 hex digits of its SHA-256, and links to the SCHEMA-AP-NDE SHACL file and specification.

The look follows https://erfgoedkijker.coret.org/ (colours, pills, cards). The font stack
starts with Inter but the font is not embedded: without Inter installed the system font
is used. The dark theme is derived from the same palette; the reference site is light only.

## Design decisions

- **Engine: [shacl-engine](https://github.com/rdf-ext/shacl-engine) 1.1.3, pinned, with a
  fix.** Pure JavaScript, so the tool installs with npm alone, and fast. Out of the box it
  lost results compared with Apache Jena (see Observations); `lib/validate.js` replaces
  `Shape.prototype.validate` to repair that, and bounds the engine's bookkeeping so that
  dumps with millions of target nodes can be validated. The version is pinned exactly because the
  fix touches an internal. `rdf-validate-shacl` 0.6.5 was measured as the alternative: about
  three times slower, and it missed 1,693 of 9,710 results on the broken test set.
- **Loading: streaming, with a predicate filter.** The input is parsed as a stream
  (N3.js for the Turtle family and for `.gz`, `rdf-dereference` / `rdf-parse` for JSON-LD,
  RDF/XML, RDFa and for content negotiation on URLs). Only statements whose predicate the
  shapes can look at are kept in memory: every IRI in a `sh:path`, the predicates of
  `sh:targetSubjectsOf` / `sh:targetObjectsOf` and of property pair constraints, plus
  `rdf:type` and `rdfs:subClassOf`. For SHACL Core this cannot change the outcome. The
  filter switches itself off when the shapes use `sh:closed`, SPARQL or JavaScript
  constraints or targets, which can look at any statement. `--all-triples` switches it off
  by hand.
- **Shapes are fetched on every run** with `Cache-Control: no-cache`. The report records
  the source, fetch time and hash so it is clear which version was used.
- **`http://schema.org/` is reported, not repaired.** The shapes only match
  `https://schema.org/`. Data in the legacy namespace is validated as is, which means not
  at all, and the report says so prominently. `--schema-https` rewrites the namespace
  first; the report then notes that the source itself still uses the legacy namespace.
- **Exact counts, bounded list.** A large dataset can give millions of results; 100,000
  listed results already make a page of about 7 MB. Totals per error, per severity and per
  filter value are always exact. When a report has more than 50,000 results, the list
  keeps at most `--max-per-error` results (default 1000) per distinct error, and the page
  says so. Text search, sorting and the CSV download then cover the listed results only.
- **No RDF report in between.** The model is built straight from the engine's result
  objects; a report graph for millions of results would not fit in memory.
- **Dictionary-encoded JSON**: severities, messages, paths, constraint components and
  shapes are stored once and referenced by index.
- **No framework**: the page script is plain JavaScript and builds the DOM with
  `textContent`, never `innerHTML`. In the embedded JSON `<`, `>`, `&`, U+2028 and U+2029
  are escaped, so data cannot close the script element. Only `http(s)` IRIs become links.

## JSON model

```json
{
  "meta": { "source": "mh.nt", "generated": "2026-11-10T14:03:12.000Z",
            "triples": 92233, "triplesKept": 64545,
            "shapes": { "source": "https://raw.githubusercontent.com/...", "fetched": "...", "sha256": "..." },
            "engine": "shacl-engine 1.1.3", "conforms": false,
            "schemaOrgHttp": 0, "schemaRewritten": false, "targeted": true,
            "total": 1351, "count": 1351, "truncated": false },
  "prefixes": { "schema": "https://schema.org/", "sh": "http://www.w3.org/ns/shacl#" },
  "dict": {
    "severity":  [{ "iri": "http://www.w3.org/ns/shacl#Violation", "label": "Error" },
                  { "iri": "http://www.w3.org/ns/shacl#Warning", "label": "Warning" },
                  { "iri": "http://www.w3.org/ns/shacl#Info", "label": "Info" }],
    "path":      [{ "label": "schema:associatedMedia", "iri": "https://schema.org/associatedMedia" }],
    "component": [{ "label": "sh:QualifiedMinCountConstraintComponent", "iri": "..." }],
    "shape":     [{ "id": "_:n3-176", "label": "_:n3-176", "name": "CreativeWorkAssociatedMediaCardinalityShape" }],
    "message":   [{ "nl": "Voeg minimaal ...", "en": "At least one ..." }]
  },
  "summary": [[1, 0, 0, 0, 1351, 1351]],
  "results": [
    ["http://data.bibliotheken.nl/id/mh/m991000590359707151", 1, 0, 0, 0, 0, null]
  ]
}
```

- A result row is
  `[focus, severity, message, path, component, shape, value, details?, sourceConstraint?]`.
  The five middle fields are indexes into `dict` (`-1` when absent).
- A summary entry is `[severity, message, path, component, results, distinct focus nodes]`
  with exact totals. `meta.total` is the number of results, `meta.count` the number listed
  in `results`; `meta.truncated` is true when these differ.
- `dict.severity` always starts with `sh:Violation`, `sh:Warning`, `sh:Info` (indexes 0,
  1, 2), followed by any custom severities.
- Terms are encoded as `"iri"`, `"_:label"` or a literal `["value"]`, `["value", "@lang"]`,
  `["value", "xsd:integer"]`. Untagged messages use the key `""`.

## SHACL coverage of the report

Checked against [SHACL section 3.6, Validation Report](https://www.w3.org/TR/shacl/#validation-report).

| Property | Handling |
|---|---|
| `sh:conforms` | "Conforms" badge when true and something was validated; no badge when false (the severity counts tell that story) |
| `sh:result` | One row per result, or a bounded number per error in very long reports |
| `sh:focusNode` | Column, search, link for `http(s)` IRIs |
| `sh:resultPath` | Column and filter; property paths are rendered SPARQL style (`^p`, `p/q`, `p\|q`, `p*`, `p+`, `p?`) |
| `sh:value` | Column (hidden when no result has a value), search |
| `sh:sourceShape` | Column; `sh:name` or `rdfs:label` of the shape, else of the node shape it is a property shape of, else its blank node label |
| `sh:sourceConstraintComponent` | Column and filter, shortened (`MinCount`), full IRI as tooltip |
| `sh:sourceConstraint` | Shown in the expanded row |
| `sh:detail` | Not produced: the engine runs without details (Jena does not give them either) |
| `sh:resultMessage` | Column and filter, per language tag with a language switch |
| `sh:resultSeverity` | Chips and filter; `sh:Violation` is labelled "Error"; other IRIs are shown as their local name |

`lib/parse.js` can still read a SHACL report written by another validator
(`parseReport`, used by the tests); the command line no longer offers that.

## Comparison with Apache Jena

Jena 5.6.0 (`shacl validate`) is the reference. For each set both validators got the same
shapes file and the multisets of (focus node, path, severity, constraint component) were
compared.

| Data | Statements | Results (Jena) | Tool vs Jena |
|---|---|---|---|
| `mh.nt` (KB, medieval manuscripts) | 92,233 | 1,351 Warning | identical |
| `mh.nt` with deliberately broken values | 85,514 | 6,585 Error, 3,125 Warning | identical |
| 64 example files of the schema-profile repository, namespace rewritten | 8 to a few hundred each | 188 in 57 files | identical |

The Gouda Tijdmachine dump (`goudatijdmachine.nt.gz`, 388 MB, 39,051,190 statements of
which 10,775,782 are kept) was run with this tool only, not with Jena: 303,179 results
(1,612 Error, 301,567 Warning, 18 distinct errors) in 452 s with about 15 GB of memory;
the page lists 3,620 results and is 488 KB.

The same holds with and without the predicate filter. Before the fix described below, 7
of the 64 example files differed.

## Observations

- **shacl-engine 1.1.3 drops results.** `Shape.validate()` remembers which (shape, focus
  node) pairs were validated, but stores the results under a key that includes the value
  path and looks them up without it. When a property shape is first evaluated in a nested
  context (`sh:or`, `sh:node`, `sh:qualifiedValueShape`) and later directly from a target
  shape, its value-level results are lost. The NDE shapes have exactly this structure
  (`_:MediaObjectShape` and `_:AssociatedMediaValueShape` share property shapes), so a
  literal `contentUrl` went unreported. `test/fixtures/shapes.ttl` reproduces it; the fix
  is in `lib/validate.js`. Not reported upstream yet.
- **The schema.org JSON-LD context yields `http://schema.org/`.** JSON-LD with
  `"@context": "https://schema.org"` expands to the legacy namespace when the context is
  fetched from schema.org. 60 of the 64 example files in the schema-profile repository are
  therefore not validated at all by a plain run of this tool or of Jena; they need
  `--schema-https`.
- **An empty report is not a pass.** Without any target node (wrong namespace, or simply
  no `schema:CreativeWork` and the like) the result is `sh:conforms true` with zero
  results. The page shows "Nothing was validated" instead of "Conforms".
- `sh:conforms` is false as soon as there is any result, also when all results are
  warnings.
- Blank node labels are only meaningful inside one run.
- **shacl-engine keeps unbounded bookkeeping.** One Set entry per evaluated (shape, node)
  and one Map entry per result, for the whole run. A JavaScript Map or Set holds at most
  2^24 entries, so the Gouda dump (over a million `schema:Person` nodes) failed with "Map
  maximum size exceeded". `lib/validate.js` bounds the memo (cleared at 500,000 entries;
  memoisation is only an optimisation) and keeps a separate, small set for the recursion
  guard.
- Loading all 39 million statements of that dump into an N3.js store was stopped after
  14 minutes at 17.9 GB; with the predicate filter loading takes 2.5 minutes.
- For results without `sh:message` in the shapes the engine writes its own text
  ("Less than 1 values"), which differs from Jena's wording.

## Validate

```
npm test          # 16 tests, offline (node --test)
```

The tests cover the model builder, the loaders (Turtle, JSON-LD, RDF/XML, gzip), the
predicate filter, the engine fix (regression), the legacy namespace handling, list
shortening, output naming and the command line. `test/fixtures/data.*` and `shapes.ttl`
are checked against Jena: the expected five results in `test/validate.test.js` are what
`shacl validate` gives.

To repeat the comparison with Jena on other data:

```
/opt/apache-jena-5.6.0/bin/shacl validate --shapes shacl.ttl --data data.nt > jena.ttl
node cli.js data.nt --shapes shacl.ttl -o tool.html
```

and compare `parseReport(jena.ttl)` with the JSON in `tool.html`. The page itself was
checked in headless Chromium (filters, sorting, paging, language and theme switch,
notices, CSV); that check is not part of `npm test`.

## Not working yet

- [ ] Report the shacl-engine cache bug and the unbounded bookkeeping upstream; re-check the fix on every engine upgrade
- [ ] Automated comparison with Jena and browser test of the page script in `npm test`
- [ ] Dumps that do not fit in memory even after filtering
- [ ] Listing every result of a very long report (use `--max-per-error 0`, at the cost of
      a very large page)
- [ ] Search in message text, and search beyond the listed results in a shortened report
- [ ] Subclass reasoning in the "Nothing was validated" check
- [ ] Compressed input other than gzip (`.bz2`, `.zip`)
- [ ] Writing the SHACL report as Turtle
- [ ] `sh:detail` (nested results explaining a failed `sh:node` or `sh:or`)
- [ ] Shape details beyond the name (the shape definition itself is not shown)
- [ ] UI translations: the interface is English only, messages follow the shapes
- [ ] Embedded Inter font
