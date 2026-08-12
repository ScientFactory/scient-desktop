# Scient Sources foundation

Status: implemented local-first foundation; user visual acceptance remains a
separate gate.

## Ownership and dependency shape

`packages/scient-sources` owns the source schema, normalization, metadata
diagnostics, duplicate assessment, operations, receipts, and project-local
store. It has no React, Electron, or T3 application dependency. Zotero is an
adapter into that model; it is never the source of Scient's scientific truth.

The server owns environment-scoped transport and local Zotero access. The web
feature owns presentation and orchestration. The inherited host is changed only
at narrow seams:

- additive typed environment HTTP endpoints;
- one generic `{ kind: "scient", module: "sources" }` right-panel surface;
- one lazy Sources render branch; and
- one Sources entry in the existing right-panel menu.

The feature does not replace project registration, panel layout, environment
auth, asset transport, or the PDF reader. `SourcePdfPreview.tsx` translates a
stored source attachment into the existing `ScientPdfReader` contract.

## Durable project store

`.scient/project.json` remains the sole project identity authority established
by Scient project initialization. Sources use this project ID and create only
their own subtree:

```text
.scient/sources/
├── records/                 one versioned JSON record per source
├── files/sha256/<prefix>/   content-addressed PDF copies
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

Stored attachment paths use portable POSIX-relative syntax and are resolved
only within `.scient/sources`. Records whose project identity does not match
the current folder are rejected.

## Source truth and provenance

The persisted record has a first-class Scient source type and normalized
bibliographic fields. The original Zotero library ID, item key, item version,
and raw item type remain external provenance. Field provenance is recorded only
for values actually supplied by Zotero.

Metadata completeness is derived from the record rather than persisted as a
possibly stale quality label. Missing title or creator produces a warning;
missing year or persistent identifier remains visible informational evidence.

Duplicate assessment is ordered from strongest to weakest:

1. exact external origin;
2. normalized persistent identifier;
3. identical PDF SHA-256;
4. possible normalized title/lead-creator/year match; and
5. new source.

Possible metadata matches are never silently merged. The first slice imports
only candidates classified as new.

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

## Operations and recovery

An import operation contains a bounded selection of unique Zotero item keys.
The coordinator advances one pending item at a time. Each record/PDF unit is
durable before its operation item is marked imported. Replaying an operation or
item is safe because exact origins and content are assessed again.

The UI may stop after the current item. Completed work remains in the project;
pending items remain explicitly unprocessed in the cancellation receipt. An
operation left running with no pending items is finalized during the next
overview inspection.

## Deliberate exclusions

This slice does not implement Zotero write-back or sync, reference editing,
automatic possible-duplicate merging, citation rendering, annotations,
evidence claims, whole-library import, cloud transport, mobile UI, or a separate
Studio route. Later source systems should add adapters into the same domain and
store rather than add provider-shaped fields to the host application.

## Verification boundary

Package regressions cover schema diagnostics, duplicate strength, project
identity, idempotency, PDF integrity, cross-platform path safety, resumable
progress, and cancellation receipts. Adapter regressions cover normalized
metadata and field provenance. Right-panel and General Chat policy tests cover
the only inherited UI-state seam. Visual and interactive acceptance remains a
manual user gate in an isolated Scient (Dev) candidate.
