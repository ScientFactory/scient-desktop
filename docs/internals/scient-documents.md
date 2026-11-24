# Scient document system

Status: Draft
Owner: Yaacov
Created: 2026-10-22
Last updated: 2026-11-24
Purpose: Routes document workflows to their Help and implementation owners and explains shared authority boundaries.
Doc type: Current implementation

## Scope and authority

This is the entry point for document creation, editing, saving, recovery,
building, reading, quoting and export. The detailed owners below define each
format's behavior and limitations. This map does not replace their contracts or
approve future architecture.

The shared boundaries described here were inspected against Desktop source
`8006e7bbdab5d2a724a628a2f3c4d3c6d81821ea` on 2026-11-10. Following a link
does not imply that every claim in the linked owner was revalidated at that
revision. Source inspection, passing tests, manual acceptance and release
qualification are separate evidence.

## Read by task

| Task                                                       | Help                                                                                                                               | Implementation owner                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open, create, rename, move or remove a file                | [File previews](../user/file-previews.md)                                                                                          | [File opening](scient-universal-file-opening.md), [saving](scient-file-saving.md)                                                                             |
| Write Markdown and use Source                              | [Markdown](../user/markdown.md)                                                                                                    | [Rich Markdown](scient-rich-markdown-editor.md)                                                                                                               |
| Write LaTeX, use templates, build and navigate a PDF       | [LaTeX](../user/latex.md)                                                                                                          | [Visual authoring](scient-latex-visual.md), [builds and navigation](scient-latex.md)                                                                          |
| Resolve save failures, outside changes or earlier versions | [Markdown saving](../user/markdown.md#saving-refused-edits-and-recovery), [LaTeX](../user/latex.md)                                | [Saving workspace files](scient-file-saving.md)                                                                                                               |
| Read, search, quote or save a PDF                          | [PDF reader](../user/pdf-reader.md)                                                                                                | [PDF reader](scient-pdf-reader.md)                                                                                                                            |
| Export Markdown, HTML or a conversation                    | [Markdown](../user/markdown.md), [file previews](../user/file-previews.md), [conversation export](../user/export-conversations.md) | [Document PDF](scient-document-pdf-export.md), [Browser PDF](scient-browser-pdf-export.md), [conversation and Word conversion](scient-conversation-export.md) |
| Import sources and format references                       | [Sources](../user/sources.md)                                                                                                      | [Sources foundation](scient-sources.md)                                                                                                                       |
| Use shortcuts, math or mixed-direction text                | [Shortcuts](../user/keybindings.md), [math](../user/math-in-chat.md), [direction](../user/content-direction.md)                    | [Keyboard](scient-keyboard.md), [math](scient-math.md), [direction](scient-content-direction.md)                                                              |
| Connect a folder to Overleaf and sync                      | [Overleaf](../user/overleaf.md)                                                                                                    | [Overleaf engine](scient-overleaf-engine.md), [agent tools](scient-overleaf-agent-tools.md)                                                                   |

## Source, input, files and artifacts

Markdown and LaTeX source files are authoritative. Rich editors project them
and propose supported source changes. Unsupported syntax can require Source or
an exact-source field; a rendered object does not prove every edit is supported.
Untouched source and edited ranges have different preservation guarantees.

A document can contain several versions of work at once:

1. A focused field or rich editor can hold input that has not become accepted
   source. An unfinished command, composition or refused conversion is not a
   successful file save.
2. Accepted working source belongs to the per-file session. A recovery record
   protects the material it actually contains; it is not disk acknowledgement.
3. The server publishes source through workspace file mutations. A save receipt
   and a history copy have distinct meanings and lifetimes.
4. A compiler or converter produces derived output. A successful build, a
   current generated PDF and a copied file at the requested destination are
   separate outcomes. Export and navigation must use their own source and
   artifact evidence.

Quotation captures are also separate from editing and publication. Source,
rendered document and PDF selections have different mapping adapters. A quote
in the composer is unsent; it does not create a bibliography record or a durable
document annotation. The Sources library, manuscript citation keys and captured
passages retain separate identities.

## Shared saving and remaining divisions

Markdown, LaTeX `.tex` and bibliography `.bib` views lease the same per-file
document registry and coordinator. Their implementation still lives under
`apps/web/src/scient/markdownEditor/persistence`; that name does not make
Markdown the owner of LaTeX semantics. Source and rich views do not create
competing save queues for one file.

The current document coordinator retries failed saves and normally keeps the
person's text after a conflicting outside change, offering the other version
back. A conflicting restored session draft asks **Keep my draft** or **Use the
file**. These rules do not make every intermediate field or recovery state
restart-safe. [Saving workspace files](scient-file-saving.md) owns publication,
history, notices, retry behavior and filesystem limits.

Two important divisions remain:

- Plain text and code files still use `components/files/fileSaveCoordinator.ts`,
  with its own retry and conflict choices.
- LaTeX Visual has additional recovery stores and comparison-first offers.
  An offer that cannot be parked can pause editing to protect its live slot.
  `.bib` entry forms do not have a general startup draft-recovery offer. The
  shared registry still journals exact admitted publication intents for every
  participating format; that does not checkpoint all newer ordinary drafts.

Production saves and Overleaf application use plain publication on every host,
with file history for replaced content. Native retained-publication code remains
for older unfinished records and explicit test paths. Its presence is not a
current macOS-only saving contract. File history, local recovery and Undo are
different mechanisms, and none is a complete immutable project backup.

## Other shared boundaries

| Concern                                 | Current source owner                                                                   | Boundary                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Source patches and document transitions | `packages/scient-document/src`                                                         | Source-neutral patches do not contain editor DOM positions.                                       |
| Markdown interpretation                 | `apps/web/src/scient/markdownEditor/prosemirror`                                       | Ledger, grammar, serialization and refusal remain format-owned.                                   |
| LaTeX interpretation and paper          | `apps/web/src/scient/latex`                                                            | Physical include ownership, MathLive, nested fields and browser pagination remain LaTeX-owned.    |
| Authoring chrome                        | `apps/web/src/scient/writing`                                                          | Shared names and components do not imply equal commands, history or search scope.                 |
| Filesystem writes and history           | `WorkspaceFileMutations.ts`, `FileHistory.ts` under `apps/server/src/scient/workspace` | The selected environment server owns filesystem authority.                                        |
| Generated PDFs                          | `packages/scient-document-artifacts`, `apps/server/src/scient/documentArtifacts`       | Immutable revisions, logical bindings and publication receipts differ from workspace file copies. |
| PDF reading                             | `apps/web/src/scient/pdf`                                                              | Source identity differs from per-thread viewing state.                                            |
| Input settlement                        | `apps/web/src/scient/editorFlush`, `apps/server/src/scient/editorFlush`                | Overleaf requests folder editor flushes; native app quit does not use this handshake.             |

Shared chrome does not establish one parser or serializer. Rich Markdown,
read-only preview, print and Word conversion can interpret the same syntax
differently. Visual LaTeX layout and counters approximate supported source;
the compiled PDF determines TeX's final output. A browser operating on a remote
environment uses that environment's files and installed tools.

## Overleaf and qualification

Folder connection, settings, review screens, authenticated routes and agent
tools are mounted. Mutating Overleaf operations ask participating windows to
save the folder's editors before proceeding. This is distinct from ordinary
autosave and from native quit. Sync conflicts, unknown publication attempts,
retained material and interrupted work keep their own explicit handling.

Mounted integration and synthetic tests do not qualify real-cloud behavior,
cloud-provider folders or every installed platform. The Overleaf owner separates
those requirements. Likewise a compiler installation, test definition or old
passing test receipt does not establish the current end-to-end document journey.

## Maintenance

Update Help and the detailed owner when observable behavior changes. Keep
source/currentness, pending input, refusal, failure, recovery and platform
boundaries together. Recheck affected commands and references against their
actual mounted paths, including negative cases. Broader product priorities and
proposed editor changes belong in Scient's product/planning repository; they
must not be presented as implementation merely because this map links the
relevant source.

## Document Lab desktop preview

The macOS development candidate can offer built-in skills for Word, Excel,
PowerPoint, existing PDFs, Google Workspace, document review and reusable
templates. From the candidate worktree, run `node scripts/setup-document-lab.mjs`
with the repository's Node version and `uv`, LibreOffice, Pandoc, Poppler, qpdf
and FriBidi available. The setup installs the locked Python and Node
dependencies into a separate generation inside the candidate's
`.scient-next/document-lab` folder and publishes it after the capability
probe. Start the candidate afterwards so the skill catalog picks up the
generation. When the preview catalog is available in a turn, its note tells
agents to load the matching Scient skill before choosing a workflow. The
note names the Scient loader so agents can distinguish it from a provider's
own loader when skill names or coverage overlap.

Agents use `scient_document_runtime` to locate the staged tools on the
candidate's server. The tool is visible on every platform and reports
`preview-disabled` outside the preview. When ready it reports paths. It runs
no document operations. Use the preview with trusted fixtures. The native tools come from the host, and the
runtime does not isolate their filesystem or network access. Shipping requires
patched, pinned native tools and isolation for document jobs. Google writes
use the active Drive connector and require its edit scopes.

When updating files under the seven preview skill directories, regenerate and
format the embedded payload with `node scripts/sync-document-lab-skills.mjs`
and `pnpm exec vp fmt apps/server/src/scient/skills/BuiltInDocumentLabSkillSources.ts`,
then run `BuiltInSkillReleases.test.ts`. Setup retains older runtime folders so
in-flight jobs can keep using their paths. Remove unused generations only after
the candidate and its document jobs stop, preserving the generation named in
`active.json`.

### Word tracked-replacement job

`scient_docx_tracked_replace` is the first server-owned document job. It makes one
tracked replacement in a new copy of a project `.docx` and saves the copy and its
PDF. Unlike the preview runtime, the server owns the whole operation: it reads the
source, enforces the revision, stages private copies, runs LibreOffice, checks the
results and publishes them. Only that tool is new; the preview runtime and skills
are unchanged.

- **Opt-in tool setup.** Run
  `node scripts/document-lab-office.mjs setup` in a candidate checkout. It
  downloads the LibreOffice build pinned in
  `apps/server/src/scient/documents/docxJob/officeToolchainManifest.ts`, rejects
  any other size or digest and unpacks it without a system install. On macOS it
  copies the app out of the DMG, on Windows it uses an administrative MSI unpack,
  and on Linux it requires `dpkg-deb` and the LibreOffice runtime libraries.
  `--use-installed` records an existing install
  that prints the pinned version, marked `host-install` because its bytes were not
  digest-checked. At start the server registers the tool only in a desktop dev
  candidate with a valid receipt, and only after the engine prints the pinned
  version and build. Other targets, including Arm Windows and Arm Linux, never
  see it.
- **Input identity.** Callers pass `sourceRevision` (`sha256:` and the source's
  bytes). On macOS and Linux the server reads through the handle-bound reader in
  `documentExport/verifiedWorkspaceRead.ts`. Windows has no handle-bound read, so
  the existing rule for unbound reads applies: only bytes equal to the revision
  the caller already holds are used. The source is re-read and compared under the
  publication fence. The Word copy is published only to a new path.
- **Accepted inputs and edits.** Plain `.docx` only. The job refuses macros,
  external relationships other than hyperlinks, fields that include or link
  outside content, and `altChunk`/`subDoc`. The text must occur exactly once and
  sit inside one plain run of one paragraph, not inside a field or an existing
  revision. Text that spans runs is refused rather than merged.
- **Worker boundary.** LibreOffice converts only the staged source and candidate
  copies. It runs in a private job folder under the server state, with a
  throwaway profile, an environment built from nothing (no `LD_*`/`DYLD_*`, dead
  proxies), a deadline and owned-tree kill, one job at a time. It does not use the
  imported `office/soffice.py` or its shared-temporary `LD_PRELOAD` socket shim,
  and a launch that names either is refused. This is a process boundary, not an
  OS sandbox: soffice still runs with the user's rights. Results therefore say
  `inputPolicy: trusted-fixtures` and `osSandbox: false`. Accepting arbitrary
  uploaded files or production use needs qualified per-job isolation first.
- **Checks before saving.** Every part except `word/document.xml`, and every
  byte outside one paragraph, must be unchanged. Rejecting the new revisions must
  restore that paragraph exactly, and accepting them must equal the source with
  the one replacement. Comment anchors, equations, tables, RTL markers, breaks and
  revisions are counted before and after. The candidate's PDF is compared with
  LibreOffice's render of the source: same page count, the deletion where the
  original text was, the insertion beside it, earlier pages identical, the same
  text sequence plus the insertion, and all fonts embedded. If any check fails,
  nothing is published. Inspect paragraph alignment and the displayed reading
  order in the exported PDF. The `bidi-neutral-at-edge` warning highlights
  edits near punctuation, symbols or numbers in an RTL paragraph, including
  direction inherited through paragraph styles or document defaults. Fonts come
  from the host, so renders differ between platforms; each render is compared
  only with the source rendered on the same host.
- **Qualification.** `DocxTrackedReplacement.integration.test.ts` runs the
  bilingual fixture against the real engine when `SCIENT_DOCUMENT_LAB_SOFFICE`
  is set. The fixture includes comments, an equation, tracked edits, a
  multipage RTL table with a repeated header, and deliberately preserved
  layout defects in the Hebrew paragraph alignment and signed range. A
  corrected control verifies that the edited Hebrew line stays at the right
  margin and produces a PDF for visual inspection. The
  qualification workflow covers Apple Silicon and Intel macOS, Windows x64,
  and Ubuntu x64. `node
  scripts/document-lab-office.mjs qualify --soffice <path> --evidence <dir>`
  reproduces it locally.
