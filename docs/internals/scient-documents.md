# Scient document system

Status: Draft
Owner: Yaacov
Created: 2026-10-22
Last updated: 2026-11-10
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
