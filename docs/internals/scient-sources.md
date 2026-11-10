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
`useScientSources` delegates the panel's transient import, overview, and Zotero
browsing state to one reducer. The durable server import operation remains the
only authority for import phase, per-item status, cancellation, retry, and
resumption. Synchronous request tokens are partitioned by workflow lane and are
reset to the exact same values in the hook and reducer when the selected project
changes. This lets routine overview refreshes and Zotero searches progress
without invalidating a running import, while late responses from an older
request or project are discarded.
Concrete material selection is centralized in
`@scientfactory/scient-sources/material-selection`: one eligible PDF may be
selected automatically, while several eligible PDFs require an explicit
stable attachment ID. The details surface presents that choice instead of
treating `attachments[0]` as architectural meaning. List and context-menu PDF
actions use the same contract: one eligible PDF opens directly, while several
PDFs route the researcher to the details choice. PDF-based metadata refresh
also refuses to choose among several materials implicitly; identifier-based
refresh may still proceed independently. The same provider-neutral contract
distinguishes absent, unsupported, missing, duplicate-ID, hash, and byte-length
states for adapters without silently selecting another material.
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
├── history/<source-id>/     kept prior revisions (first one plus the latest 49)
├── trash/<source-id>.json   removed sources, whole, until restored or deleted
├── text/sha256/<prefix>/    extracted PDF text, one JSON file per PDF hash
├── collections.json         collections and saved searches
├── operations/              resumable import state
├── receipts/                terminal import evidence
└── staging/                 bounded temporary copies
```

There is deliberately no canonical mutable manifest. An overview is derived
from validated records and operations. The overview contract returns bounded
summaries only (tags included, so the list can filter by them); complete
abstracts, provenance, and revision evidence are
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
endpoint for bibliographic identity. The embedded date counts as the
publication date only from XMP `prism:coverDate` or `prism:publicationDate`;
the document-info `CreationDate` and Dublin Core `dc:date` describe the file
and are ignored. Records imported before this keep their stored date.

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

Registry lookups read the user's research keys from Accounts through
`researchKeys.ts`: the API-key row whose sites match the service (OpenAlex,
Semantic Scholar, NCBI, and the Unpaywall email), skipping a row set to Off.
Tools take the resolver through `keyedIdentifierLookup`, which passes the keys
as `Redacted` values; the Effect HTTP client gets them as `Redacted` URL
parameters so spans show them redacted. Paper downloads send the OpenAlex key
and ask Unpaywall only when OpenAlex has no free copy. The Library's registry
contact email goes to OpenAlex as `mailto` and to Unpaywall when no Unpaywall
email is saved.

All NCBI E-utilities requests share one serialized, interval-limited lane.
The lane remains owned until the active network request settles and releases
in `finally`, preventing overlapping requests and avoiding a dead lane after a
failure.

Every registry request goes through `metadataHttp.ts`, which sends the
versioned `METADATA_USER_AGENT`. The Library setting
`scientSources.registryContactEmail` (Settings ▸ Documents) is followed by
`RegistryContact.layer`; when it holds an address, requests to
`api.crossref.org` and `api.openalex.org` (including redirect hops, such as
doi.org to Crossref) carry it as the `mailto` parameter and in the
User-Agent. No other host receives it, and an empty or malformed value sends
nothing. Adapters that pass the address another way (Unpaywall's `email`)
read `registryContactEmail()`; none keeps its own setting.

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
provenance naming their writer (`user`, or `agent` for edits through the
Sources toolkit); provenance for unchanged fields is preserved. Metadata, note
and attachment writes also record the writer as the record's `updatedBy`, and
an edit that changes identifiers drops the record's identifier verification.
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

Provider agents use the same canonical store through a bounded ten-tool
Sources MCP toolkit:

- `scient_sources_list` and `scient_sources_get` are bounded, read-only views;
- `scient_sources_note_update` and `scient_sources_update` use optimistic
  revision safety for notes and canonical metadata;
- `scient_sources_add` creates an idempotent source from supplied metadata or a
  project-relative PDF after checking its identifier (below);
- `scient_sources_attach_pdf` and `scient_sources_detach_pdf` change canonical
  attachments without exposing host paths; and
- `scient_sources_remove` moves a source to the trash through the same
  revisioned removal path as the UI, `scient_sources_list` with `inTrash`
  lists the trash, and `permanent` deletes a trashed source for good;
- `scient_sources_restore` puts a trashed source back; and
- `scient_sources_revert` makes a kept revision current again.
  `scient_sources_get` returns the kept revisions with who saved each and which
  fields changed.

Paper downloads reach the store through `paperIntake.ts`. A `scient_paper_get`
or `scient_papers_queue` request with `addToLibrary` (or `sourceId`) needs the
`sources:write` grant; without it the PDF is only saved and the result says so.
Once the queue has saved the PDF, the intake attaches it to the source whose DOI
or arXiv ID matches, at that source's current revision, or creates a source
through the same resolver as an agent add (`origin.intake: "paper"`, credited to
the agent, or to the user for their own queue). Its candidate holds only the
asked identifier; OpenAlex's title and year are kept, with `openalex`
provenance, only when no registry answers. The DOI in the PDF's own text is not
used, since it can be a cited work. A not-found DOI adds nothing, and a possible
metadata match is reported for the agent to decide. Each downloaded attachment
records `retrieval`: the route (`open-access`, `publisher`, `university`,
`library`) and the version (`published`, `accepted`, `preprint`, or `unknown`
when the repository did not say). A copy already in `papers/` records none.

Before an agent add writes anything, the server checks the source's DOI at
doi.org (CSL-JSON), or failing that its PMID through PubMed esummary on the
shared NCBI request lane, within a 6.5-second deadline. A DOI that doi.org
itself reports as unregistered, or a PMID PubMed has no summary for, returns
`identifier-not-found`; a registered work whose title does not match the
title the agent supplied returns `identifier-mismatch` with the registry's title, first
three creators, year and container. Neither writes a record. A confirmed
identifier makes the registry's bibliographic fields authoritative, with `doi`
or `pubmed` field provenance carrying the identifier and retrieval time, and
stores verification `verified`. An unreachable or unusable registry adds the
source as given with `unchecked`; a source without a DOI or PMID is
`unverified`. An exact duplicate is reported without a lookup, and optional
abstract enrichment runs after the check. Only agent adds record verification.

Connector results reach the Library as identifiers, not copied metadata. The
resolver also takes an OpenAlex work ID (`openalex`, `W…`) and a Semantic
Scholar paper ID (`s2`, a 40-character paper ID or `CorpusId:N`), tried after
every registry scheme. `ConnectorIdentifierLookup.ts` reads the catalogue entry
(OpenAlex at 10 requests a second, Semantic Scholar at one), follows its DOI,
then PMID, then arXiv ID through the ordinary scheme lookups, and keeps the
catalogue ID among the record's identifiers (both Semantic Scholar IDs, paper ID
and `CorpusId`, when it gives them). A registry that does not have the
identifier the catalogue names refuses the work like any other add
(`identifier-not-found`, naming that identifier in `named`). A registry that
cannot be reached returns unavailable with the catalogue's record, which the
agent add keeps as unchecked with the registry identifiers. A work no registry
names is the catalogue's own record (`catalogueOnly`, `openalex` or
`semantic-scholar` provenance) and is added unverified. A catalogue that does
not know the ID returns not found. OpenAlex and Semantic Scholar IDs are
work-level identifiers in exact duplicate matching.

Agent-added sources are not held for approval. Trust comes from that check,
from attribution (origin actor, field provenance, `updatedBy` and revision
history, all shown in the Sources panel) and from ordinary edit and removal.
New records always store origin review `none`; older records that still say
`pending` decode unchanged, and nothing gates on the value.

The toolkit is project-scoped, writes Zotero only through
`scient_sources_zotero_send`, and does not create a
second agent-owned notes or source format. Read and write capabilities are
separate, mutating tool descriptions require an explicit user request, and
normal agent tool authorization remains the approval boundary rather than a
separate Sources permission UI. Providers that receive Scient's MCP session
always receive `sources:read` and `sources:write`; these baseline capabilities
are independent of optional preview-browser control. The capability checks
remain the server authorization boundary, and exact project/worktree
resolution remains server-owned.

Metadata refresh is an explicitly destructive operation guarded by a compact
confirmation surface. The environment server re-runs the existing local-PDF
and exact DOI/PMID resolvers, rechecks the record revision after asynchronous
resolution, and writes only evidence-backed, non-empty candidate fields through
the normal revisioned metadata-update path. The refresh may replace prior
manual corrections, but it cannot change source identity, attachments, or the
imported PDF.

Source removal uses the same canonical-root write lane as imports and metadata
edits. It requires the revision the researcher reviewed and is idempotent when
a successful response is lost. Removal saves the current revision to history,
writes the whole record to `trash/<source-id>.json` with who removed it and
when, and only then deletes the live record, so a crash leaves the source
listed rather than lost. Restore writes the trashed record back as a new
revision credited to the restorer; it refuses when a live record with the same
ID exists (`exists`) or another live source has the same identifier
(`duplicate`). Importing a trashed source again supersedes its trash entry.

Neither removal nor detaching a PDF deletes PDF files. Permanent deletion
(one trashed source, or the whole trash) deletes the trash entries and their
revision history, then deletes every content-addressed PDF that no live or
trashed record refers to. It deletes no file at all while any record or trash
entry cannot be read, since that record might refer to it. Revert and history
listing do not keep PDFs alive: a revert whose revision names a deleted file
leaves that attachment out and reports `missingAttachmentCount`.

Revert copies an earlier revision's content into a new revision credited to
the actor, keeping the source's identity, `importedAt` and origin. It returns
`stale`, `not-found` (revision not kept), `unchanged` or `duplicate` (the
reverted identifiers belong to another live source) without writing. Each
source keeps its first revision and the most recent ones, 50 including the
current record; older revisions are pruned after each write.

Listing reads every record file independently. A file that is not valid JSON,
does not decode, belongs to another project or does not match its file name is
skipped and reported in the overview's `unreadableRecords` with its
project-relative path; the UI shows one quiet line naming the files. Reading a
single source by ID still fails for that source alone.

The UI moves a source to the trash straight from the row's secondary-click
menu or the details page and offers Undo in the confirmation toast; the trash
popover in the Library header restores or empties it. The row's secondary-click
menu uses the existing host context-menu bridge.

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

## Citation keys

Each record carries an optional `citationKey`, the key documents cite it by
(`[@key]`, `\cite{key}`). The rules live in
`packages/scient-sources/src/citationKeys.ts` and are applied by the store when
a record is created, under the same write lock as duplicate assessment:

- A key the importer brings (Zotero, Better BibTeX, a `.bib` entry) is kept;
  characters Pandoc or BibTeX cannot read are dropped. Importers set
  `citationKey` on the candidate and never generate keys themselves.
- Otherwise the key is generated from the lead author's family name, the year
  and the first significant title word in ASCII (`smith2020deep`).
- Keys are unique per project, compared case-insensitively as BibTeX does; a
  clash adds `a`, `b`, … `z`, `aa`.
- A key never changes on its own. Editable metadata without `citationKey`
  keeps the current key; a different value is a deliberate rename, validated
  for syntax and uniqueness and credited to the actor like any other field.

Records written before keys existed decode unchanged and have no key until one
is assigned.

## Managed bibliography

`apps/server/src/scient/sources/ManagedBibliography.ts` is the only writer of
the project's `references.bib` and `references.json` (CSL-JSON, `id` = citation
key), rendered by `@scientfactory/scient-citations/bibliography` and sorted by
key. The store reports every settled write through
`onScientSourceRecordsChanged`; the server coalesces those into one sync per
project, so writes from people, agents and every import path keep both files
current. A sync first gives keyless legacy records a key (oldest first).

Scient keeps a copy of what it last wrote in `.scient/sources/bibliography/`.
A project file that differs from that copy was edited by hand and is kept
(`edited`, with the keys added, changed or removed); a file Scient never wrote
is `unmanaged` and is never written over. Only an explicit `replaceEdited` from
the user or an agent restores the Library version. The project file is written
before the copy, so an interrupted write is adopted on the next sync instead
of reported as an edit. Nothing is written for a project without a Library.

`importEdited` sends an edited file through the ordinary reference-file import
(`importBibliographyFile`). Only when the edit added entries and every added
key is then in the Library, with nothing changed or removed, is the file
written again; otherwise it stays edited for the person to decide.

## Citing

Documents cite by key. In Markdown, typing `[@` opens a list of Library
sources (`prosemirror/libraryCitation.ts`, ranked by
`sources/libraryCitations.ts`) and inserts the existing Pandoc `citation`
node; the LaTeX citation dialog appends Library sources after the document's
own `.bib` entries. A citation opens its source through
`librarySourceRequest.ts`, which the Library panel acts on once loaded.

A deliberate key rename goes through `updateScientSource`, which then rewrites
the key in project Markdown citations (outside code) and LaTeX `\cite`-family
key lists (`renameCitationKeyInDocument`); `citationKeyRenamedIn` lists the
files. Nothing else changes a key, so a key a document uses stays frozen.

`scient_sources_cite` (`LibraryCitation.ts`) runs the shared reference check
(`checkReferences` with a Library `sourceIds` target) on the sources about to
be cited and reports identifier, retraction, notice, published-version and
registry-detail findings next to the citation it returns; it never withholds
the citation.

Markdown Word export passes a CSL style to Pandoc: the document's `csl:`
front matter (a bundled `apa` or `vancouver`, or a project `.csl` file), else
the request's `citationStyle` from Settings, else Pandoc's default. Library
sources are the lowest-precedence references (`fallbackCitations`), after the
document's front matter and named bibliographies. Export only reads records.

## Collections, saved searches and bulk edit

`packages/scient-sources/src/collections.ts` owns
`.scient/sources/collections.json`; `organize.ts` holds its schemas and the
one filter model (text, tags, collection, type, PDF) that the panel list,
saved searches and `scient_sources_list` all compile through
`compileScientSourceFilter`, so a search means the same thing to a person and
an agent.

- Collections are stored apart from records and never rewrite them. Members
  are source IDs; a removed source keeps its membership and is only hidden, so
  restoring it from the trash restores its collections too. Reads project
  members onto the sources that exist.
- Names are unique per project without regard to case. Creating a name that
  exists returns that collection and adds the given sources, so a repeated
  agent request is harmless. Deleting a collection or saved search marks it
  deleted (the latest 50 are kept) so it can be restored.
- Every change goes through `organizeScientSources` (one action union shared by
  the `organize` HTTP endpoint and `scient_sources_organize`) under one write
  lock, credited with `updatedBy`.
- A collections file that cannot be decoded is reported as an `issue` on the
  overview and hides collections, but never breaks the source list; writes
  refuse instead of overwriting it.
- `bulkUpdateScientSources` applies tag (case-insensitive, existing spelling
  kept) and type changes as ordinary metadata revisions, one per source with
  one retry on a stale revision, then membership changes. Each source is
  reported; one failure does not stop the rest. Bulk removal is the trash
  removal per source, with one Undo for the batch in the panel.

## Reference files

`packages/scient-sources/src/bibliography/` reads and writes BibTeX/BibLaTeX,
RIS, CSL-JSON and EndNote XML as pure functions with no new dependency (a
small XML reader handles EndNote). Every parser yields format-neutral entries
that keep the citation key (normalized by `citationKeys.ts`), the project note
and, per entry, the source fields that have no Scient field (`notKept`).
Entries that cannot be parsed are skipped with their line, so one damaged
entry does not lose the file. `planBibliographyImport` turns a parse into
candidates: it drops empty entries, repeats within the file (same content or
same work-level identifier) and entries already in the Library, and only then
takes the first `SCIENT_SOURCE_IMPORT_ITEM_LIMIT` new ones. Importing the same
file again therefore continues a large file instead of re-processing the first
batch. Field provenance is `file` with `sourceField` `<format>:<field>`.

The server adapter (`BibliographyFileAdapter.ts`) bounds a file to 32 MB,
falls back to Windows-1252 when a file is not valid UTF-8, stages the batch as
one JSON file under `.scient/sources/staging/files/<operationId>.json` with its
report, and starts an ordinary durable operation (`adapter`/`intake` `file`).
Advancing reads candidates from that stage; the stage is removed when the
operation settles without failures or is cancelled, and kept for retry while
failed items remain. File imports record verification `unchecked` with their
DOI or PMID, or `unverified` without one: the identifiers are the file's, not
the registry's. Agents import a project-relative file with
`scient_sources_import_file`, which runs the same operation to completion;
files inside `.scient/sources` are refused. Adapter error messages are written
for people, while filesystem errors (which can carry host paths) are replaced
before they reach a model.

Export (`exportBibliography`) writes the Library or a selection under each
record's citation key; a record without one gets a free key from the same
rules for that file only. Project notes are excluded unless requested.
`scient_sources_export` writes a project file atomically, refuses `.scient/`
and paths outside the project, and replaces an existing file only with
`overwrite`.

## Zotero boundary

One reader (`ZoteroLibraryReader.ts`) works over two transports. The local
transport (`ZoteroLocalAdapter.ts`) uses Zotero's read-only local API v3 at the
fixed loopback endpoint `127.0.0.1:23119`, plus Better BibTeX's local JSON-RPC
`item.citationkey` for keys an item does not carry itself. The web transport
(`ZoteroWebAdapter.ts`) reads and writes the key owner's personal library at
`api.zotero.org`. Neither scans Zotero's database or accepts arbitrary hosts.
Responses are time- and size-bounded and decoded through explicit schemas;
mapping lives in `ZoteroItems.ts`.

The zotero.org key comes from Accounts (`ZoteroAccountKey.ts`): the newest
API-key account whose site is zotero.org or whose variable is `ZOTERO_API_KEY`.
Off always stops its use. For agents, the global agent switch and the account's
project scope apply and Ask counts as allowed, as for connector bindings: the
saved key is the user's approval. Each use is recorded in Accounts activity
without the value. The key is read on the server, sent only to
`api.zotero.org` (file redirects drop it), and never appears in tool output.
Key checks (`/keys/current`) are cached for five minutes by key digest; writes
check again.

Without a requested connection, the status check prefers Zotero on this
computer and falls back to zotero.org when a key works; the chosen connection
travels with browse, preflight and import requests, and a zotero.org import is
recorded with the `zotero-web` operation adapter so resumed steps read the same
library. Local item keys and zotero.org keys name the same items in the user's
personal library (local library ID `0` and the zotero.org user ID are the same
library). Group libraries are not supported.

Connection states distinguish ready, access disabled (or a refused key),
incompatible API, malformed response, and unreachable. The local API alone
cannot honestly prove whether an unreachable Zotero installation is absent or
merely not running, so the product does not invent that distinction.

Library pagination advances by the number of raw Zotero items received, even
when notes, annotations and attachments are filtered from the Scient view.
Import re-fetches each selected item with all its children immediately before
storing it. Child notes (HTML) become the source note as plain text with
Markdown bold and italic; every stored or linked PDF is copied (the first with
the record, the rest attached), and a PDF Zotero cannot provide is skipped
rather than failing the item. zotero.org PDFs are streamed to a temporary file
that is removed after import. Identifiers Zotero keeps in Extra (PMID, PMCID,
arXiv, DOI for types without a DOI field) and the citation key (Zotero's field,
then Better BibTeX's `Citation Key:` line, then Better BibTeX's JSON-RPC) are
read; S2's key rules keep it.

Zotero collections are intake scopes when browsing. After an item is imported
it joins a Library collection (`collections.json`) named after each Zotero
collection it belongs to, nested ones as `Parent / Child`; a collection problem
never fails the import. Scope discovery is capped at 500 importable references
per operation and fails with a request to choose a smaller scope above that
bound. Collection and whole-library actions skip the separate preflight
screen; each item is still validated, duplicate-assessed and committed by the
normal importer, and exact or possible matches are skipped. A zotero.org
preflight does not hash PDFs (that would download every file); identifier,
origin and metadata duplicate checks still run.

### Refresh and Send to Zotero

`ZoteroSync.ts` keeps, per source, what Zotero held at the last import,
refresh or send in `.scient/sources/sync/zotero/<sourceId>.json`, apart from
the record. Refresh (`ZoteroRefreshPlan.ts`) is a three-way merge against it:
a field Zotero changed is taken unless it was edited here (field provenance
`user` or `agent`), in which case the value here is kept and reported as a
conflict. A conflict keeps its old merge base, so it is reported again until
the user takes Zotero's value (`useZotero`) or keeps theirs (`keepLocal`).
Empty Zotero values never clear a field; tags merge as additions and removals;
notes follow the same rule as fields; new PDFs (by attachment key) are
attached; the record's Zotero item version is updated; an item gone from Zotero
is reported and left alone. Without a sync file (sources imported before this
existed), every difference counts as a Zotero change. The citation key is never
changed by a refresh.

Send to Zotero (`ZoteroWrite.ts`) is one way and needs the zotero.org key with
write access. A source without a Zotero item is created with a write token
derived from its project, ID and revision (a retry creates nothing new), with
the source note as a child note, and the source is linked to the new item. A
linked source is patched with only the fields that differ, using the item's
own field set and `If-Unmodified-Since-Version`; if the item changed in Zotero
since Scient last read it, nothing is sent and the user is asked to refresh.
Empty values here are never sent. Extra keeps its unmanaged lines and carries
the citation key and identifiers without a Zotero field. PDFs are not uploaded.

Agent tools `scient_sources_zotero_browse`, `_import`, `_refresh` and `_send`
give agents the same power; their messages pass through only Zotero's own
explanations, never local paths.

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

## Full text

Full text is derived data keyed by PDF `sha256`, never part of a record, so
several sources sharing one PDF share one text file and no record revision
changes when text is extracted. `packages/scient-sources` owns the stored
shape and pure search (`/full-text`) and its filesystem store
(`/full-text-store`); the server owns extraction (`SourceFullText.ts`).

- Each page is stored in the reader's text profile
  (`PDF_TEXT_PROFILE`: raw pdf.js item strings, a newline after `hasEOL`
  items) with its view box, rotation and user unit, so stored offsets and
  reader quotes describe the same text. A test pins the two profile names
  together.
- A background pass starts when the Library loads or a full-text tool runs. It
  parses one PDF at a time across all projects and yields between pages, since
  pdf.js shares the server's event loop. Library-wide search never waits for it
  and reports `pending`; reading one source's text or checking a quote against
  one source extracts that PDF on demand through the same lane.
- An unreadable PDF is recorded as `failed` and retried only after the pdf.js
  version changes. A text file that does not decode is treated as missing and
  extracted again. Text whose PDF file is gone from `files/` is pruned; text of
  a trashed source stays while its PDF does.
- Writes are atomic and every directory below the project root is checked one
  segment at a time, so a symlinked `text/` folder cannot redirect them.

Search is a pure-JS scan of cached, folded page text rather than SQLite FTS5:
the text is project data in project files, while the server's SQLite holds app
state, and a second persistent index could drift from the files. Folding
lowercases, strips accents and punctuation and joins line-end hyphenation.
Terms score by rarity across PDFs and repetition inside a 360-character window,
quoted phrases are required, and terms of four or more characters also match as
prefixes. The cache is capped by characters and keyed by hash, since stored
text never changes for a hash.

Quote checking matches verbatim first, then after folding spacing, ligatures,
quote marks, dashes, and line-end and intra-word hyphens on both sides. It
works across page boundaries, returns the stored text with its page offsets
and context, and calls a repeated quote ambiguous instead of choosing one.
OpenAlex full text is not used: its content downloads need a key and are paid
per file.

The attachment-preview endpoint returns the attachment's content-addressed
hash and size; the Sources PDF reader carries them as the descriptor's
`material`, so quotes from Library PDFs record proven bytes. A Library search
hit opens through the reader's quote reveal: the panel files the hit, and the
PDF preview turns it into a target with its own document identity once the
authorized preview names the file. Server and web pdf.js versions can differ,
so such targets are found again by their text rather than by offsets.

## Saving browser pages

`SourceWebPage.ts` saves a page through the same identifier-checked add path
as agent adds and downloaded papers (`origin.intake: "web"`). Identifiers come
from Highwire Press, Dublin Core and PRISM tags, then from DOI, PubMed and
arXiv addresses (`packages/scient-sources/src/webPage.ts`); the page's title is
not treated as a claim about the identified work. A page without an identifier
is a `web` source and is the same source as another with the same address. The
selection is appended to the note once. On desktop, a fixed script reads the
tab's title, selection and meta tags; the address comes from the tab itself,
and a PDF tab is fetched again through the tab's session and handed to the
Library's normal PDF import.

## Deliberate exclusions

This slice does not implement two-way Zotero sync, Zotero group libraries,
uploading PDFs to Zotero, attaching PDFs named
in a reference file's `file` field, source merging,
automatic possible-duplicate merging, multi-source
bibliographies, arbitrary CSL style installation, annotations, evidence claims,
OCR of scanned PDFs, fuzzy metadata search, mobile UI, or a separate Studio route.
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
