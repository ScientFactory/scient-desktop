# Scient conversation export

Scient exports a conversation from a server-side snapshot, never from the chat timeline. This page
describes the snapshot, readable document exports, portable conversation files, and import. The
[accepted proposal](./scient-conversation-export-import-proposal.md) records the design decisions;
the implementation here remains subject to release qualification.

## Pipeline

```text
projections ──(one SQL transaction)──▶ ConversationSnapshotV1 ──▶ DocumentBundle ──▶ writer ──▶ file or text
```

| Stage                                                                                | Where                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Contracts (snapshot, bundle, options, capabilities, HTTP)                            | `packages/contracts/src/scientConversationExport.ts`                |
| Snapshot builder, work-log projection, bundle adapter, Markdown v1 writer and reader | `packages/scient-conversation` (`@scientfactory/conversation`)      |
| Snapshot read, export service, temporary files, HTTP group                           | `apps/server/src/scient/conversationExport/`                        |
| Client request helpers                                                               | `packages/client-runtime/src/state/scientConversationExportHttp.ts` |
| Dialog, format registry, thread-menu entry                                           | `apps/web/src/scient/conversationExport/`                           |

## Snapshot

`ConversationSnapshotService` reads the thread detail with its complete history
(`getThreadDetailById(…, { fullHistory: true })`, so the detail view's activity window does not
apply), the projection sequence, and the thread's latest event sequence inside one
`sql.withTransaction`. The transaction ends before attachment files are inspected or anything is
rendered. The snapshot records both sequences and the capture time; the content digest is a SHA-256
of the canonical content and excludes them, so two captures of the same state have the same digest.

- **Running turn.** When the session's active turn or the latest turn has not completed, the
  snapshot stops before it: its messages, activities, plans, answers, and the prompt that started it
  are left out, and exactly one `running-turn-omitted` warning names it.
- **Selection.** Work log, reasoning, and range are applied while capturing. Unselected content is
  never read into the snapshot.
- **Range.** "Up to a message" ends at exactly the chosen user or assistant message: later messages
  are left out, and so are work log, reasoning, plans, and answers recorded after it, including
  later items of the turn it belongs to or, for a steering message, interrupted. Records at the
  chosen message's own time come after it. `selectConversationContent` applies the bound once,
  before projection, so every format gets the same content; attachments of excluded messages and
  answers are never looked up, read, or charged to the byte budget. The server does not accept a
  range yet: every export path refuses `through-message` with `range-unavailable`. Known limitation
  to solve before accepting ranges: the cut uses creation times, and a plan, reasoning block, or
  message created before the chosen message but updated after it keeps its creation time while
  carrying the later content.
- **Messages.** User, assistant, and system messages outside the running turn, numbered `n = 1…`.
  As in chat, a settled turn's message counts as complete even if a crashed provider left its
  streaming flag set.
  Reasoning-role messages are a separate list. Inline references (composer context chips and
  captured quotes) are rewritten to `scient-ref:<id>` links with typed entries; environment, thread,
  and message ids, absolute workspace roots, file revisions, and editor positions are dropped, and
  paths are made project-relative.
- **Work log.** An explicit allowlist of activity kinds, each mapped to fixed display fields (title,
  tool name, status, command, detail, changed files, bounded output). Tool lifecycle updates collapse
  per call, task progress per task, and a turn keeps its latest plan checklist. Provider payload
  objects are never copied. Approval requests and unanswered questions are never included; answered
  questions are kept as question-and-answer interactions. An imported entry's activity records what
  its sender's export left out (`scientExportOmissions`: cut lines and characters per text, and how
  many changed files and plan steps were dropped); the projection keeps that text as it is and those
  counts, so exporting an imported conversation again keeps its "and N more" notices.
- **Warnings** agree with the facts: one `attachment-unavailable` warning per attachment whose file
  was missing, carrying its name and its snapshot message number (`null` for an answer attachment),
  and none for available attachments.

Size bounds (`boundText`, `boundItems`) keep the head and tail and write an
`[… N lines omitted …]` line.

## Document bundle

`buildConversationDocument` turns a snapshot into a `DocumentBundle`, the input every readable
writer shares. It follows chat's rendering decisions per message:

| Content           | Line breaks                                                            | Raw HTML                                                                                             |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| User message      | Always kept (chat renders with `remark-breaks`)                        | Escaped: chat parses user Markdown without raw HTML and shows tags as text                           |
| Assistant message | Kept only for `★ Insight` blocks (`shouldPreserveAssistantLineBreaks`) | Kept: chat renders it through `rehype-raw` and `rehype-sanitize`; viewers apply their own sanitizing |
| Reasoning         | Always kept                                                            | Kept                                                                                                 |

Kept line breaks are written as explicit hard breaks (`\` before the newline) in text only, never
inside code or math, so every Markdown renderer shows them as chat does. Work log and reasoning are
attached to the message chat shows them under (the terminal answer of their turn), using the
grouping shared with chat (`@scientfactory/conversation/work-log-grouping`, the same functions
`MessagesTimeline.logic.ts` imports; that subpath has no parser code). Assets are addressed as
`scient-asset:<id>`; file-excerpt quotes become a quotation plus the project-relative source file
and are listed in `citations`. Images referenced by a path on the original computer (for example
`![Plot](./figures/plot.png)`) become an "Image not included" placeholder with a
`resource-unresolved` warning; remote and data images are kept. Where raw HTML renders (answers,
plans, reasoning), `<img>` tags with such a `src` get the same placeholder and warning. When work log
or reasoning is included, a `sensitive-content-included` warning puts the dialog's caution into the
file.

Bundle warnings refer to messages by the numbers the file shows, after system messages and
answers folded into their question are left out; an answer's unavailable attachment is reported
once, with the answer. Quoted names and alt texts are shortened (`warningValue`) so every warning
fits `DocumentWarning`'s 2,048 characters.

Attachment content comes from the writer. Text-only Markdown, Copy, and the Word diagram plan list
attachments from their recorded sizes (`external` content) and never open the files. A `.zip` or
`.scic` checks each file against the 512 MiB export budget (a `.scic` also hashes it by streaming)
and streams it into the archive when that entry is written, so about one entry is in memory at a
time; an entry whose size or digest changed since the check fails the export. PDF and Word read the
bytes they embed. An attachment over the budget is listed by name with a "too large to include"
warning.

## Scient conversation Markdown v1

```markdown
---
scient: conversation
scient-format: 1
scient-export: 7f3c9a2e41b8
title: Export and import design
exported: 2026-09-28T09:12:00.000Z
---

# Export and import design

_Exported from Scient · 2 messages · codex · gpt-5_

<!-- scient:message export=7f3c9a2e41b8 n=1 role=user time=2026-09-27T14:05:00.000Z -->

## You · 27 Sep 2026, 17:05 GMT+3

Please investigate …

<!-- scient:message export=7f3c9a2e41b8 n=2 role=assistant time=2026-09-27T14:06:10.000Z turn=1 -->

## Assistant · 27 Sep 2026, 17:06 GMT+3

Here is what I found …

<!-- scient:part export=7f3c9a2e41b8 kind=work-log -->
<details>
<summary>Work log · 3 steps · Worked for 1m 2s</summary>
…
</details>
```

- The `scient-export` value is random for each export and repeated in every marker. Only
  top-level HTML comment blocks carrying the file's own value are markers; quoted markers, markers
  in code, and markers from another export are content.
- `n` numbers the messages in the file from 1. `role` is `user` or `assistant`. `time` is the
  message time in UTC. `turn` is the file-local ordinal of the assistant turn; consecutive messages
  of one turn share it (a user message between them does not end the turn) and user messages carry
  none. A turn whose messages return after another turn continues under a new ordinal, because a
  reader rejects a turn that reappears.
- The speaker heading right after a marker is generated for people and is not part of the message.
  Headings inside a message are kept.
- `scient:part` markers introduce generated material attached to the message: `attachments`,
  `context`, `plan`, `answers`, `work-log`, `reasoning`. The message body ends at its first part.
- Text before the first message marker (title, metadata line, export notes) is not a message.
- A body's literal `<!-- scient:` outside code is written as `&lt;!-- scient:`.
- Reference-link labels, footnote labels, explicit anchors (`id`/`name` attributes and `{#id}`),
  and same-message `#fragment` links to them are prefixed with `m<n>-` (`m<n>-p<k>-` for plans,
  `m<n>-r<k>-` for reasoning). The reader removes the prefix.
- A body that ends inside an unclosed fence, `$$` block, or HTML block of types 1–5 is closed with
  the matching terminator. A body that still would not leave the next marker at top level is written
  as a literal fenced block and reported with an `unsupported-construct` warning.

`parseConversationMarkdown` reads this grammar with the Markdown parser. A file without this front
matter is a `document`, never a transcript. It returns the messages whose markers parsed cleanly
and issues (`foreign-marker`, `malformed-marker`, `duplicate-number`, `out-of-order-number`,
`missing-number`, `unknown-role`, `invalid-time`, `unknown-part`) with their lines. On import, the
preview discloses these issues before confirmation; malformed or ordinary Markdown is not silently
treated as a complete native conversation.

## Delivery

`POST /api/scient/conversation-export/v1/prepare` returns the title, format capabilities for this
host, counts, whether a turn is running, and message choices for an "up to a message" range. The
contract carries that range, but the server refuses it (see Range above) and the export dialog
always exports the whole conversation. The response carries no full export, but its message choices include bounded
excerpts of message text and should be treated as conversation content.
`POST /api/scient/conversation-export/v1/export` produces the export; both require
`orchestration:read`.

- **File delivery** writes `<state>/scient/conversation-exports/<exportId>/<name>.md` or `.zip`
  (`name.md` plus `attachments/NN-name`, written with `yazl`). The name comes from the title and is
  at most 200 UTF-8 bytes including the extension, never a Windows device name (`CON`, `NUL`,
  `COM1`, …) and never ending in a dot or space. Attachment names inside a package keep letters,
  digits, `.`, `_`, and `-`, are cut on code points, and are bounded in UTF-8 bytes. A failed
  archive leaves no file behind. The server returns a signed `environment-file` asset URL that
  expires with the file. The directory is cleared when the server starts and swept every five
  minutes; exports older than 30 minutes are removed.
- **Clipboard delivery** returns text-only Markdown inline, up to 8 MiB of text.
- Scient's own state and base directories (as configured and as resolved) are replaced with
  `«scient-data»` in the snapshot's text before any writer escapes it, with either path separator,
  in any case, and only where the root's path ends: before a separator, the end, a character that
  cannot continue a path segment (so `**/data**` and `<code>/data</code>` are redacted), or trailing
  punctuation followed by whitespace, the end, or a formatting delimiter ("(see /data)," and
  "in /data."), never inside a longer name (`/database`, `/data.bak`, `/data#archive`, `/data_/x`,
  `/data(backup)/x`). Redaction is intentionally conservative: an unusual sibling path that shares
  a storage root's exact prefix and ends in a formatting delimiter may be over-redacted, which is
  accepted because real storage roots are long and specific.
- The client saves a file with the shared Save Copy path: the native save dialog in desktop
  (`apps/desktop/src/scient/documentArtifacts/AssetCopy.ts`) and a download in a browser.

Formats this server cannot produce are advertised with `available: false` and a reason. The
responses decode forward-compatibly: an older client drops a format it does not know, shows a
warning with an unknown code by its message, and reads a refusal with an unknown reason by its
message. PDF is not written by `export`: the `documents.prepareConversationPdf` RPC builds the same
bundle with the dialog's options (`ConversationExportService.document`), captures it for Scient's
document page, and the client prints and publishes it as described in
[document PDF export](./scient-document-pdf-export.md).

## Other export and conversion paths

- **Portable `.scic`.** The server writes a versioned ZIP with a canonical conversation snapshot,
  Markdown reading copy, manifest, and included attachments. A turn whose messages return after
  another turn continues as a new turn (`<turnId>~2`, …) in the package, with its other records
  joining the run they were recorded in, because the importer requires each turn to be contiguous.
  Before writing, the writer decodes its own manifest, checks every entry path with the reader's
  rules, and runs the reader's conversation validation (`ValidatedConversationImport`); a package
  that would fail them is an internal error, never a file handed to the user. A receiver previews and validates
  structure, digests, size bounds, and omissions before choosing a local project and provider.
  Confirmation creates a new independent thread with fresh local IDs and explicit import
  provenance. Provider sessions, pending actions, credentials, and workspace files do not transfer;
  foreign tool calls are never replayed.
- **PDF.** The controlled desktop document page renders the entire saved conversation or project
  Markdown file, waits for fonts/images/math/diagrams, then prints and publishes a searchable PDF.
  Rendering failure stops publication; the live chat UI is not printed.
- **Word.** A managed, pinned Pandoc executable converts the document bundle or a saved project
  Markdown file to `.docx`, with a Scient reference style. LaTeX projects enter Pandoc's LaTeX reader
  directly. File conversion checks the saved revision again on the server. LaTeX includes,
  bibliographies, and figures, and the images of a Markdown file, are read through the same
  handle-bound reader as PDF (`documentExport/verifiedWorkspaceRead.ts`): a file or folder swapped
  for a link after its path check is refused, never read. On Windows, where no read can be bound
  to the checked file, a LaTeX export reads only the file open in the editor, at its saved
  revision, and is refused if it needs any other project file; a Markdown file's images are read
  by path and rechecked there. Pandoc availability is
  explicit and first use requires installation; a missing tool is not silently replaced with a
  lower-fidelity converter. Unsupported content is reported as warnings.
- **Markdown import.** Scient-marked Markdown v1 can reconstruct the readable message transcript
  with disclosed losses, while an ordinary Markdown file is imported as a document rather than
  impersonating a native conversation. Both enter the same preview-and-confirm flow as `.scic`.

The portable importer uses staged files, a bounded quota, a durable attempt journal, an
idempotent command receipt, and rollback of exactly the files it owns if the import does not
commit. Fork, revert, and provider continuation operate on the imported thread's inherited
history; they do not adopt the sender's provider session. [Import](#import) describes the
staging, limits, and failure handling.

Word export of a conversation or saved project Markdown file asks the server for the Mermaid fences
in the selected snapshot or saved revision. The browser renders each fence to a bounded PNG and
returns the bytes with that source digest. The server rereads the authoritative source, checks the
digest and every diagram ID, and passes only validated PNG bytes to Pandoc. It never accepts an asset
path from the client or fetches a remote resource for this step. Diagram IDs hash the fence source as
Pandoc reads it (carriage returns dropped; the read pass keeps tabs), so CRLF and tab-indented fences
match their captured image.

Mermaid draws into a live document before its SVG can be inspected, and in strict mode it still
creates what a diagram asks for (an `<img>` in a label, an image shape, a sequence-actor icon, CSS
`url()`). Word capture therefore draws in a hidden same-origin frame (`diagrams/isolatedMermaid.ts`, shared with chat)
whose Content Security Policy allows only Mermaid's self-contained script, inline styles, and
`data:`/`blob:` images and fonts; the browser refuses every other load before a request is made, and
a refused load makes that diagram fall back. The frame loads Mermaid's standalone build only when an
export has diagrams, and draws with the settings chat uses (`mermaidRenderConfig`). As a second layer,
`wordExport/diagramSafety.ts` refuses, before drawing, styling statements (`style`, `classDef`,
`linkStyle`, `cssClass`) with CSS fetch functions and configuration outside the theme, layout, and
per-diagram options, read as Mermaid parsed it from front matter and `%%{init}%%`; each styling
statement ends at a newline or an unquoted `;` (keeping a style list's later declarations), and label
text is not inspected. Sources over chat's render limit (50,000 characters) are not drawn, because
Mermaid would substitute a small "text size exceeded" diagram; its own error diagram also falls back. The rasteriser inspects the SVG again before drawing. Any diagram that is refused, needed
an outside resource, fails to render or encode, or exceeds the PNG budget is captured as
`render-failed`: Word shows its labeled Mermaid source with a warning, and the export continues. A
server-only Word caller that supplies no capture retains the same fallback.
The two Word export POST routes cap request bodies at 12 MiB before JSON parsing; the PNG budget is
2 MiB per diagram and 8 MiB in total. An oversized chunked request may have its connection reset
by the Node HTTP adapter as it stops reading the body.

## Import

The contract between staging and the importer is the header of
`apps/server/src/scient/conversationImport/ConversationImporter.ts`. In practice:

- **Upload.** `createUpload` admits a `.scic` of up to 768 MiB or a `.md` of up to 16 MiB against
  the staging quota (2 GiB for all imports together) and at most eight live imports, and returns a
  signed, single-use upload URL valid for 10 minutes. A receive ends after 60 seconds without bytes,
  or at a deadline of 10 minutes plus the declared size at 256 KiB/s; a stalled, slow, short, or
  cancelled upload each gets its own message. Cancelling during an upload stops the receive and
  waits for it: the reservation stays counted until the stream has stopped, the file is closed, and
  the staging area is removed. An area that cannot be removed yet (a file still open on Windows)
  stays counted until the sweep removes it.
- **Validation (preview).** Validations and imports run one at a time. The quota covers uploaded
  packages and what validation stages; the one package being validated may expand beyond it by
  at most its own expanded size (720 MiB). The reader decodes `conversation.json` (at most
  128 MiB) once, compares its canonical form with the JSON structurally, and hashes the canonical
  text as it writes it. A ready import keeps only its preview facts and attachment list in memory;
  its snapshot waits in the staging area byte for byte and is read back, digest checked, when it
  is confirmed. The opt-in benchmark
  (`SCIENT_IMPORT_BENCH=1`, `ConversationImportBenchmark.test.ts`) validates a 122 MiB snapshot in
  about half a second, with the process growing by about 0.6 GB while it runs (macOS arm64).
- **Record limit.** One import writes at most 5,000 records (messages, reasoning, work-log entries,
  plans, and answers) in its single `thread.conversation.import` transaction; a larger file is
  refused at preview with a message that suggests exporting again with the work log and reasoning
  turned off. The limit comes from the benchmark's work-log-heavy import on an on-disk
  database: about 3.5 s at 5,000 records, 14 s at 10,000, and 65 s at 20,000.
- **Clock rollback.** An import moves times later than the import back to the import time
  (`timesShiftedMs`); if the server's clock is later set back before that time, messages sent
  afterwards sort before the imported history, as a thread's new messages sort before its older
  ones whenever the clock goes backwards.
- **Refusals and retries.** A refused file ends the import and removes its area; every rejection
  reason has its own short message, and a reported entry name is bounded, trimmed, and omitted when
  blank. Failures a retry may clear (no room yet, or an operating-system error such as a file
  that cannot be opened) keep the upload, so the next preview validates it again. Once a file is
  validated its package is removed; a package that cannot be removed yet stays counted against the
  quota until the sweep removes it.
- **Confirm.** Attachments are published into the attachment store before the thread commits, each
  flushed to disk before its rename and its folder after, so a published file survives a power
  loss. The command's receipt then decides the outcome, as the contract describes. A committed
  import's result is kept for 24 hours and answers first: a confirm repeated because its first
  answer was lost returns the same result, and a cancel reports the import as already done, even
  while the staging area is still being removed. "Not found" means no such import is staged and
  none committed.
- **Partial Markdown.** Importing only the clean messages of damaged Scient Markdown counts each
  damaged range whose content was left out as a skipped record (a foreign marker kept as text, or
  a gap in the message numbers, is not one), so the thread's banner, provider handoff, and a
  re-export keep the gap. An ordinary Markdown document is imported as the first message's
  attachment, and the provider handoff says the user shared a document, not an imported
  transcript.
- **Continuation.** The first message after an import carries a budgeted handoff of the history,
  delivered again only when the provider thread is replaced. The server reads the thread's full
  history only for a turn that must carry it.
- **Opened files (desktop).** Scient registers `.scic` with the operating system, and on macOS
  exports its document type (`com.scientfactory.scient.conversation`, conforming to
  `public.zip-archive`). The desktop captures macOS `open-file` from module load and holds opened
  paths until startup can take them, so a double-click while Scient is closed is not lost. The
  renderer uploads an opened file by token; the desktop asks before sending it to a server it does
  not manage, and `cancelOpenedConversationFileUpload` aborts an upload in progress or keeps one
  from starting. Results distinguish a declined send (`declined`), a cancel (`cancelled`), and a
  server refusal (`rejected`).

## Dialog

Thread menu (sidebar and chat header) → **Export ▸** one entry per registered format opens the
dialog preset to that format. There is no format switcher in the dialog.
Formats come from `formatRegistry.ts`, in registration order (Markdown, PDF, Word, Scient file).
Each registration names its menu entry, the dialog's info card (`about`), and its Save label; it
may add a client requirement (`clientAvailability`: PDF needs a current Scient desktop, and says so
otherwise), produce the export itself (`produce`: PDF renders on the desktop, saves through the same save dialog, and
offers **Open** on the notice; resolving `null` means the save was cancelled), and offer a way to become available (`UnavailableAction`: Word's Pandoc install, shown in
place of the options). A format this host cannot produce shows its reason and no Save button.
Work log and reasoning start off on every opening, every export covers the whole conversation (the
request's message range is not offered in the UI), and the text-only or `.zip` choice appears only
when the conversation has attachments. The dialog shows a caution line while work log or reasoning is included and warns
when a turn is running; the file's own warnings are shown after export and written into the file.
**Copy ▸ Conversation as Markdown** in the thread menu copies text-only Markdown with the default
options through the same export request with `delivery: "clipboard"`.
**Import conversation** is also available from the app menu/sidebar and file-open flow; the import
dialog displays omissions and warnings before confirmation.
