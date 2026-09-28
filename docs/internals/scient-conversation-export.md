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
  questions are kept as question-and-answer interactions.
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
  punctuation that nothing continuing a segment follows ("(see /data)," and "in /data."), never
  inside a longer name (`/database`, `/data.bak`, `/data!archive`, `/data(backup)/x`).
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
  directly. File conversion checks the saved revision again on the server. Pandoc availability is
  explicit and first use requires installation; a missing tool is not silently replaced with a
  lower-fidelity converter. Unsupported content is reported as warnings.
- **Markdown import.** Scient-marked Markdown v1 can reconstruct the readable message transcript
  with disclosed losses, while an ordinary Markdown file is imported as a document rather than
  impersonating a native conversation. Both enter the same preview-and-confirm flow as `.scic`.

The portable importer uses staged files, a bounded quota, a durable attempt journal, an
idempotent command receipt, and rollback of exactly the files it owns if the import does not
commit. Fork, revert, and provider continuation operate on the imported thread's inherited
history; they do not adopt the sender's provider session.

Word export of a conversation or saved project Markdown file asks the server for the Mermaid fences
in the selected snapshot or saved revision. The browser renders each fence to a bounded PNG and
returns the bytes with that source digest. The server rereads the authoritative source, checks the
digest and every diagram ID, and passes only validated PNG bytes to Pandoc. It never accepts an asset
path from the client or fetches a remote resource for this step. A syntax failure keeps the full
Mermaid source in Word with a warning; a renderer or PNG encoder failure stops the UI export. A
server-only Word caller that supplies no capture retains the labeled source fallback and warning.
The two Word export POST routes cap request bodies at 12 MiB before JSON parsing; the PNG budget is
2 MiB per diagram and 8 MiB in total. An oversized chunked request may have its connection reset
by the Node HTTP adapter as it stops reading the body.

## Dialog

Thread menu → **Export…** (sidebar and chat header) opens the dialog. Formats come from
`formatRegistry.ts`; a registration may add a client requirement (`clientAvailability`: PDF needs
a current Scient desktop, and says so otherwise) and produce the export itself (`produce`: PDF
opens in Scient's PDF reader instead of a save dialog). Work log and reasoning start off on every
opening, the export covers the whole conversation, and the text-only or `.zip` choice appears only
when the conversation has attachments. The dialog warns when work log or reasoning is included and
when a turn is running; the file's own warnings are shown after export and written into the file.
**Import conversation** is also available from the app menu/sidebar and file-open flow; the import
dialog displays omissions and warnings before confirmation.
