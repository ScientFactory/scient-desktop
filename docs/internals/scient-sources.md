# Scient Sources foundation

Status: implemented local-first foundation; user visual acceptance remains a
separate gate.

## Ownership and dependency shape

`packages/scient-sources` owns the source schema, normalization, metadata
diagnostics, duplicate assessment, operations, receipts, and project-local
store. It has no React, Electron, or T3 application dependency. Zotero and
direct PDF intake are adapters into that model; neither defines Scient's
scientific truth.

`packages/scient-citations` is a separate derived-output layer. It maps the
canonical Scient source record to CSL JSON and formats references with pinned
Citation.js/CSL dependencies. It does not import Zotero adapter data, mutate
source records, or persist rendered strings. The web surface lazy-loads the
processor only after source details are opened, keeping the normal app bundle
and Sources overview path free of the citation engine.

The server owns environment-scoped transport, local Zotero access, bounded PDF
metadata extraction, and identifier resolution. The web feature owns
presentation and orchestration. The inherited host is changed only at narrow
seams:

- additive typed environment HTTP endpoints;
- one Scient-owned right-panel surface registry for the library and its peer
  PDF tabs; the inherited store accepts validated descriptors without owning
  their subtype shapes, persistence normalization, labels, or icons;
- lazy Sources and source-PDF render branches; and
- one Sources entry in the existing right-panel menu.

The feature does not replace project registration, panel layout, environment
auth, asset signing, or the PDF reader. A Sources-owned authenticated endpoint
resolves an attachment ID through the project store and asks the existing asset
signer for an exact PDF URL. `SourcePdfPreview.tsx` translates that URL into the
existing `ScientPdfReader` contract. Preview authorization therefore does not
depend on a chat thread already having been persisted.

The Sources library, source details, and metadata editor are local states within the
same Scient-owned panel. A source row opens details even when no attachment is
present; an explicit PDF action opens a peer source-PDF surface. This keeps
source identity and bibliographic information separate from document display
without adding another host navigation concept or environment endpoint.
Normal local-PDF and Zotero intake use one user action after selection:
preflight runs as part of the import pipeline, new items are imported
immediately, and a single completed source opens in the existing details state.
The preflight surface is retained only for the weak possible-metadata-match
decision that cannot be made safely on the researcher's behalf.

Journal artwork is optional presentation, not source truth. A Sources-owned
read endpoint may resolve a journal article's explicit publisher origin, fetch
the conventional favicon and up to two larger first-party icons declared by the
publisher's bounded public-HTTPS home page, validate raster bytes, preserve a
smaller official icon when no better one succeeds, and cache the result under
the environment state directory. The renderer uses
the existing signed asset route and paints the generic book before lookup, on
offline resolution, and on image failure. Resolution starts only for rows near
the visible scroll region, so a large ledger does not create one network job per
stored source. Icons never enter project records, block the list, or permit the
renderer to contact arbitrary publisher URLs.

## Durable project store

`.scient/project.json` remains the sole project identity authority established
by Scient project initialization. Sources use this project ID and create only
their own subtree:

```text
.scient/sources/
├── records/                 one versioned JSON record per source
├── files/sha256/<prefix>/   content-addressed PDF copies
├── history/<source-id>/     immutable prior metadata revisions
├── operations/              resumable import state
├── receipts/                terminal import evidence
└── staging/                 bounded temporary copies
```

There is deliberately no canonical mutable manifest. An overview is derived
from validated records and operations. The overview contract returns bounded
summaries only; complete abstracts, tags, provenance, and revision evidence are
loaded through a direct source-ID detail endpoint when a researcher opens an
item. Journal artwork uses the same direct record lookup, so rendering one row
does not repeatedly decode the rest of a large ledger. Source-PDF preview keeps
the existing host seam and resolves its content-addressed attachment only when
the researcher opens it; avoiding another `ChatView`/right-panel state branch is
the deliberate upstream-maintenance tradeoff. JSON writes use a temporary file,
`fsync`, and atomic promotion. New source records use exclusive creation. PDF
copies are size-bounded, require a regular non-symlinked `%PDF-` file, are
hashed while copying, and are promoted before a source record can refer to
them. A crash can leave harmless unreferenced content, but never a committed
record pointing to a partial PDF.

Direct uploads use the selected environment's authenticated HTTP channel and a
bounded multipart body rather than an Electron-only filesystem path or a
base64/JSON copy. The environment server stages and hashes one file per request,
which bounds memory and concurrency while the UI may still select a batch.
Staged descriptors carry the normalized candidate and content identity so the
item inspected during preflight is the item later imported. Completion,
failure, cancellation, and explicit duplicate-review dismissal remove its
staging material.

Stored attachment paths use portable POSIX-relative syntax and are resolved
only within `.scient/sources`. Records whose project identity does not match
the current folder are rejected. All durable record reads enter through one
explicit format-version decoder; future migrations extend that boundary rather
than scattering version checks through adapters and UI code.

## Source truth and provenance

The persisted record has a first-class Scient source type and normalized
bibliographic fields. The original Zotero library ID, item key, item version,
and raw item type remain external provenance. Field provenance is recorded only
for values actually supplied by Zotero.

Abstracts use one provider-neutral representation: canonical plain text plus
optional titled sections derived only from explicit source markup, never
Zotero HTML, JATS XML, or provider presentation markup. The plain text remains
the searchable, editable, citation-compatible value; the sections preserve
structured-abstract meaning for presentation without guessing that a short
line is a heading. Every adapter, metadata edit, and final store write passes
through the same normalizer, so future source systems cannot accidentally
persist provider markup. Older records are normalized when read for
presentation without being silently rewritten; an explicit metadata edit
stores the canonical value in a new revision. A leading provider wrapper named
`Abstract` is discarded while its paragraphs are preserved, leaving only the
actual structured headings in the canonical document.
Provider HTML may place section bodies as bare text siblings after explicit
headings rather than inside paragraph elements. The boundary parser preserves
that text across inline markup and associates it with the preceding heading.
A legacy structured abstract containing headings but no body paragraphs is
treated as absent rather than displaying an invented heading-only summary.

Direct PDF intake uses an immutable per-upload candidate key while keeping the
content SHA-256 as the duplicate and storage identity. This prevents two
simultaneous reviews of the same bytes from overwriting each other's staged
metadata. It normalizes scalar and array-valued XMP fields independently, so a
malformed optional field cannot discard already readable metadata or prevent
first-page identifier extraction. It reads bounded document metadata and text
from at most the first two pages. A single unambiguous DOI or explicitly
labelled PMID may be resolved through the public DOI CSL JSON or NCBI ESummary
endpoint for bibliographic identity.

After a Zotero or local-PDF adapter has built its candidate, a shared
provider-neutral enrichment seam may fill a missing abstract using only that
candidate's exact DOI or PMID. The bounded resolver prefers NCBI EFetch for a
PMID, then Crossref `/works/{doi}`, with Europe PMC as an exact-identifier
fallback. Resolvers run in authority order and stop after the first verified
match; one shared deadline bounds the whole optional enrichment step instead
of waiting for every service. An abstract already supplied by Zotero, DOI
metadata, or a researcher is never replaced. Retrieved abstracts retain their
service, exact identifier, source field, and retrieval time in field
provenance.

All NCBI E-utilities requests share one serialized, interval-limited lane.
The lane remains owned until the active network request settles and releases
in `finally`, preventing overlapping requests and avoiding a dead lane after a
failure.

All metadata responses are HTTPS-only, time- and size-bounded, and
schema-decoded. Only the exact identifier leaves the project environment; the
PDF never does. Resolution failure is a normal offline fallback, not an import
failure. No visible-PDF abstract extraction, OCR, fuzzy bibliographic search,
or model inference is part of this slice because those paths need separate
identity and evidence safeguards before they can be trusted.

Generic embedded PDF Subject and Dublin Core description values may help locate
an exact DOI or PMID, but they are not treated as scholarly abstracts. Those
fields commonly contain citation strings or arbitrary publisher descriptions.
Scient stores an abstract only when an abstract-bearing source such as Zotero,
PubMed, Crossref, Europe PMC, or DOI metadata supplies one; absence is
preferable to presenting the wrong field as scientific content.

Researchers may correct canonical bibliographic metadata without changing the
source ID, project ID, external Zotero references, imported files, content
hashes, or import evidence. Each successful edit requires the revision the
researcher opened, increments the record revision exactly once, preserves the
previous record in immutable history, and atomically replaces the current
record. A normalized no-op does not create another revision and may safely
acknowledge a retry whose first response was lost. Changed fields receive
explicit `user` provenance; provenance for unchanged fields is preserved.
The stable source-type enum remains deliberately small; records classified as
`other` may carry an optional researcher-defined label without widening the
transport or citation type systems for every new scholarly genre.

Metadata edits re-run exact-identifier and possible title/creator/year duplicate
checks against the other project records. Exact identifier conflicts cannot be
overridden. A possible metadata match requires an explicit per-save decision.
Concurrent edits are serialized by canonical project root within the owning
environment server; an edit based on an older revision returns the current
record as stale instead of overwriting it.

Each source may also carry one optional project-owned note. The note is stored
on the canonical record, not in Zotero or a UI-only sidecar, and follows the
same atomic revision/history rules as metadata. The details surface exposes an
anchored quick editor and one directly editable note below the reference; both
share one autosave state and retain the local draft when another writer changes
the note first. Notes are plain Markdown text with only lightweight bold and
italic controls in this slice. Their text direction is resolved by the browser
from the note itself, so Hebrew, Arabic, English, and mixed research notes do
not inherit an unrelated application direction.

Provider agents use the same canonical store through a bounded nine-tool Sources
MCP toolkit:

- `scient_sources_list` and `scient_sources_get` are bounded, read-only views;
- `scient_sources_note_update` and `scient_sources_update` use optimistic
  revision safety for notes and canonical metadata;
- `scient_sources_add` creates an idempotent source from supplied metadata or a
  project-relative PDF and marks every agent-added source pending review;
- `scient_sources_attach_pdf` and `scient_sources_detach_pdf` change canonical
  attachments without exposing host paths;
- `scient_sources_review` approves or rejects a pending agent-added source; and
- `scient_sources_remove` removes a canonical source only through the same
  revisioned removal path as the UI.

The toolkit is project-scoped, does not write Zotero, and does not create a
second agent-owned notes or source format. Read and write capabilities are
separate, mutating tool descriptions require an explicit user request, and
normal agent tool authorization remains the approval boundary rather than a
separate Sources permission UI. Agent Browser and Sources access are currently
enabled by default together in the server-authoritative Integrations setting;
turning that setting off withholds `preview`, `sources:read`, and
`sources:write` from new provider sessions. A settings-read failure also fails
closed by withholding those capabilities.

Metadata refresh is an explicitly destructive operation guarded by a compact
confirmation surface. The environment server re-runs the existing local-PDF
and exact DOI/PMID resolvers, rechecks the record revision after asynchronous
resolution, and writes only evidence-backed, non-empty candidate fields through
the normal revisioned metadata-update path. The refresh may replace prior
manual corrections, but it cannot change source identity, attachments, or the
imported PDF.

Source removal uses the same canonical-root write lane as imports and metadata
edits. It requires the revision the researcher reviewed and is idempotent when
a successful response is lost. The current record is removed before attachment
cleanup, so a crash may leave a harmless unreferenced immutable blob but cannot
leave another source pointing to a deleted file. A content-addressed PDF is
deleted only when no remaining source record references its portable relative
path. Prior immutable metadata revisions remain valid project evidence; if the
same external source is deliberately imported again later, its record continues
after the last stored revision so a subsequent edit cannot collide with that
history. The UI exposes removal only from discreet source actions on the row or
details page and always confirms that Zotero remains unchanged. The row's
secondary-click menu uses the existing host context-menu bridge; its actions and
confirmation remain owned by the Sources surface.

Metadata completeness is derived from the record rather than persisted as a
possibly stale quality label. Missing title or creator produces a warning;
missing year or persistent identifier remains visible informational evidence.

Reference rendering uses the same stored record regardless of import origin.
The initial offline catalog contains Vancouver and APA 7. Creator roles remain
distinct when converted to CSL, corporate authors remain literal names, and
unknown fields are omitted rather than invented. The current schema is enough
for common journal articles; richer book, thesis, conference, and report
references require deliberate canonical fields rather than adapter-specific
extensions. The renderer stores only the project's selected style as a
versioned local preference; the source record and formatted reference remain
project-owned truth and derived output respectively.

Duplicate assessment is ordered from strongest to weakest:

1. exact external origin;
2. normalized work-level identifier (DOI, PMID, PMCID, or arXiv);
3. identical PDF SHA-256;
4. possible normalized title/lead-creator/year match; and
5. new source.

Possible metadata matches are never silently merged. They require a per-item
`allowPossibleMetadataMatch` decision persisted in the import operation. The
store permits that decision only for the weak metadata-match classification;
same-origin, identifier, and PDF-content matches remain non-overridable.
ISSN, ISBN, and unknown schemes are deliberately excluded from automatic work
identity. Completed operation items retain their duplicate disposition so the
web surface can report imported, already-present, and review-required counts
without deriving semantics from presentation text. Operations written before
that additive field remain readable.

When a project already contains PDFs, preflight validates and hashes the
selected local Zotero PDF before presenting the decision. Import revalidates
and hashes while copying, so the review and durable write use the same content
identity without trusting a stale path.

## Zotero boundary

The adapter uses Zotero's read-only local API v3 at the fixed loopback endpoint
`127.0.0.1:23119`. It does not scan Zotero's database, accept arbitrary hosts,
store credentials, write library data, or depend on Zotero cloud sync. Responses
are time- and size-bounded and decoded through explicit schemas. PDF paths come
from Zotero's local attachment endpoint and are revalidated by the store.

Connection states distinguish ready, local access disabled, incompatible API,
malformed response, and unreachable. The local API alone cannot honestly prove
whether an unreachable Zotero installation is absent or merely not running, so
the product does not invent that distinction.

Library pagination advances by the number of raw Zotero items received, even
when unsupported note or annotation items are filtered from the Scient view.
Import re-fetches each selected item immediately before storing it.

Zotero collections are treated only as adapter-side intake scopes; they never
enter the canonical Scient source record. The UI exposes the flat Zotero
collection graph as readable parent/child paths. Browsing and importing a
selected collection uses Zotero's bounded server-side pagination for that
exact collection; nested collections are selected explicitly. This avoids
materializing an entire collection tree merely to render one page. **My
Library** remains available as an explicit whole-library scope. Scope discovery
is read-only, capped at 500 importable references per operation, and fails
with a request to choose a smaller scope above that bound.

Collection and whole-library actions deliberately skip a separate preflight
screen. Each item is still re-fetched, validated, duplicate-assessed, and
committed by the normal importer. Exact matches and possible metadata matches
are safely skipped rather than overwriting project-owned corrections; selected
single-item intake retains the explicit possible-match override workflow.

Zotero items may have several PDF children. The adapter counts all of them and
selects one deterministically by portable filename and item key. Preflight
identifies the chosen filename and warns that the remaining PDFs are outside
this first slice. Full multi-attachment intake requires attachment-level
duplicate and presentation decisions and is deliberately deferred.

## Operations and recovery

An import operation records its adapter and a bounded selection of unique
adapter source keys. Zotero uses its library/item identity; direct PDFs use an
immutable upload identity and retain their content hash separately. The
coordinator advances one pending item at a time. Each record/PDF unit is
durable before its operation item is marked imported. Replaying an operation or
item is safe because exact origins and content are assessed again. Within one
operation, the store reuses a record snapshot only while the records directory
fingerprint remains unchanged. Another source import, edit, or removal
invalidates that snapshot before the next item, avoiding repeated full-ledger
scans without making an in-memory cache authoritative.
Coordinator lane keys and store paths both use the canonical project root, so
filesystem aliases cannot create parallel lanes for the same operation.

The UI may stop after the current item. Completed work remains in the project;
pending items remain explicitly unprocessed in the cancellation receipt. An
operation left running with no pending items is finalized during the next
overview inspection. Recovery finalization re-reads and settles the operation
under the same operation lock used by progress updates and cancellation.
Long-running operations use a compact progress surface while leaving the
project ledger visible and usable.

The web continuation driver is independent of the mounted Sources panel. Once
an operation begins, navigating away only detaches presentation updates; the
same durable server operation continues to advance. A renderer-level registry
deduplicates continuation attempts when Sources is reopened while that work is
still active. If the renderer, app, or connection stops, no state is invented:
the persisted running operation is shown on the next overview and can be
resumed from its next pending item.

Only one import operation may be running for a project in an environment
server. Concurrent begin requests are serialized, same-ID replay remains
idempotent, and a new operation is accepted after completion or cancellation.
The current store assumes the normal application ownership model of one
environment server writing a project at a time. The filesystem remains durable,
and the normal single-server write paths invalidate cached snapshots. True
multi-process writers would require an explicit cross-process locking protocol
rather than a larger in-process map.

## Deliberate exclusions

This slice does not implement Zotero write-back or sync, source merging,
automatic possible-duplicate merging, in-text citations, multi-source
bibliographies, arbitrary CSL style installation, annotations, evidence claims,
OCR, fuzzy metadata search, mobile UI, or a separate Studio route.
Later source systems should add adapters into the same domain and store rather
than add provider-shaped fields to the host application.

## Verification boundary

Package regressions cover schema diagnostics, duplicate strength, project
identity, idempotency, PDF integrity, cross-platform path safety, resumable
progress, and cancellation receipts. Adapter regressions cover normalized
metadata, abstract markup removal, and field provenance, including a JSON
round-trip through the public Zotero library response contract. Coordinator
coverage proves legacy abstract normalization and attachment
preview resolution without a persisted chat thread. Right-panel and General
Chat policy tests cover the only inherited UI-state seam. Citation regressions
prove the canonical CSL mapping and exact Vancouver and APA 7 output for a
journal article. Visual and interactive acceptance remains a manual user gate
in an isolated Scient (Dev) candidate.
