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
- two generic Scient right-panel surface variants for the library and its peer
  PDF tabs;
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
from validated records and operations. JSON writes use a temporary file,
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
reviewed item is the item later imported. Completion, failure, cancellation,
and explicit review dismissal remove its staging material.

Stored attachment paths use portable POSIX-relative syntax and are resolved
only within `.scient/sources`. Records whose project identity does not match
the current folder are rejected.

## Source truth and provenance

The persisted record has a first-class Scient source type and normalized
bibliographic fields. The original Zotero library ID, item key, item version,
and raw item type remain external provenance. Field provenance is recorded only
for values actually supplied by Zotero.

Direct PDF intake uses an immutable per-upload candidate key while keeping the
content SHA-256 as the duplicate and storage identity. This prevents two
simultaneous reviews of the same bytes from overwriting each other's staged
metadata. It normalizes scalar and array-valued XMP fields independently, so a
malformed optional field cannot discard already readable metadata or prevent
first-page identifier extraction. It reads bounded document metadata and text
from at most the first two pages. A single unambiguous DOI or explicitly labelled PMID may be resolved through the public
DOI CSL JSON or NCBI ESummary endpoint. Responses are HTTPS-only, time- and
size-bounded, and schema-decoded. Only the exact identifier leaves the project
environment; the PDF never does. Resolution failure is a normal offline
fallback, not an import failure. No OCR, fuzzy bibliographic search, or model
inference is allowed in this adapter because those paths can silently attach
the wrong scholarly identity.

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

Source removal uses the same canonical-root write lane as imports and metadata
edits. It requires the revision the researcher reviewed and is idempotent when
a successful response is lost. The current record is removed before attachment
cleanup, so a crash may leave a harmless unreferenced immutable blob but cannot
leave another source pointing to a deleted file. A content-addressed PDF is
deleted only when no remaining source record references its portable relative
path. Prior immutable metadata revisions remain valid project evidence; if the
same external source is deliberately imported again later, its record continues
after the last stored revision so a subsequent edit cannot collide with that
history. The UI exposes removal only from a source's discreet actions menu and
confirms that Zotero remains unchanged.

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
2. normalized persistent identifier;
3. identical PDF SHA-256;
4. possible normalized title/lead-creator/year match; and
5. new source.

Possible metadata matches are never silently merged. They require a per-item
`allowPossibleMetadataMatch` decision persisted in the import operation. The
store permits that decision only for the weak metadata-match classification;
same-origin, identifier, and PDF-content matches remain non-overridable.
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
item is safe because exact origins and content are assessed again.
Coordinator lane keys and store paths both use the canonical project root, so
filesystem aliases cannot create parallel lanes for the same operation.

The UI may stop after the current item. Completed work remains in the project;
pending items remain explicitly unprocessed in the cancellation receipt. An
operation left running with no pending items is finalized during the next
overview inspection. Recovery finalization re-reads and settles the operation
under the same operation lock used by progress updates and cancellation.

Only one import operation may be running for a project in an environment
server. Concurrent begin requests are serialized, same-ID replay remains
idempotent, and a new operation is accepted after completion or cancellation.

## Deliberate exclusions

This slice does not implement Zotero write-back or sync, source merging,
automatic possible-duplicate merging, in-text citations, multi-source
bibliographies, arbitrary CSL style installation, annotations, evidence claims,
whole-library import, OCR, fuzzy metadata search, mobile UI, or a separate Studio route.
Later source systems should add adapters into the same domain and store rather
than add provider-shaped fields to the host application.

## Verification boundary

Package regressions cover schema diagnostics, duplicate strength, project
identity, idempotency, PDF integrity, cross-platform path safety, resumable
progress, and cancellation receipts. Adapter regressions cover normalized
metadata and field provenance, including a JSON round-trip through the public
Zotero library response contract. Coordinator coverage proves attachment
preview resolution without a persisted chat thread. Right-panel and General
Chat policy tests cover the only inherited UI-state seam. Citation regressions
prove the canonical CSL mapping and exact Vancouver and APA 7 output for a
journal article. Visual and interactive acceptance remains a manual user gate
in an isolated Scient (Dev) candidate.
