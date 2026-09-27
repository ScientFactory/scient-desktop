# Scient conversation export

Scient exports a conversation from a server-side snapshot, never from the chat timeline. This page
describes what exists today: the snapshot, the document bundle, the Markdown writer and its file
format, delivery, and the dialog. The design, the later formats (PDF, Word, `.scic`), and import are
in the [accepted proposal](./scient-conversation-export-import-proposal.md).

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
  was missing, carrying its name and its message number (`null` for an answer attachment), and none
  for available attachments.

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
`resource-unresolved` warning; remote and data images are kept. When work log or reasoning is
included, a `sensitive-content-included` warning puts the dialog's caution into the file.

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
  message time in UTC. `turn` is the file-local ordinal of the assistant turn; messages of one turn
  share it and user messages carry none.
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
`missing-number`, `unknown-role`, `invalid-time`, `unknown-part`) with their lines. It exists for
round-trip tests today; Markdown import (PR 7) builds on it.

## Delivery

`POST /api/scient/conversation-export/v1/prepare` returns the title, format capabilities for this
host, counts, whether a turn is running, and message choices for the range picker. It carries no
exported content. `POST /api/scient/conversation-export/v1/export` produces the export; both require
`orchestration:read`.

- **File delivery** writes `<state>/scient/conversation-exports/<exportId>/<name>.md` or `.zip`
  (`name.md` plus `attachments/NN-name`, written with `yazl`). The name comes from the title and is
  at most 200 UTF-8 bytes including the extension. The server returns a signed
  `environment-file` asset URL that expires with the file. The directory is cleared when the server
  starts and swept every five minutes; exports older than 30 minutes are removed.
- **Clipboard delivery** returns text-only Markdown inline, up to 8 MiB of text.
- Scient's own state and base directories (as configured and as resolved) are replaced with
  `«scient-data»` in the snapshot's text before any writer escapes it, with either path separator
  and, for Windows roots, in any case.
- The client saves a file with the shared Save Copy path: the native save dialog in desktop
  (`apps/desktop/src/scient/documentArtifacts/AssetCopy.ts`) and a download in a browser.

Formats this server cannot produce are advertised with `available: false` and a reason. The server
advertises Markdown and PDF. PDF is not written by `export`: the `documents.prepareConversationPdf`
RPC builds the same bundle with the dialog's options (`ConversationExportService.document`),
captures it for Scient's document page, and the client prints and publishes it as described in
[document PDF export](./scient-document-pdf-export.md).

## Dialog

Thread menu → **Export…** (sidebar and chat header) opens the dialog. Formats come from
`formatRegistry.ts`; `formats.ts` registers Markdown, and a later format registers there without
changing the dialog. A registration may add a client requirement (`clientAvailability`: PDF needs a
current Scient desktop, and says so otherwise) and produce the export itself (`produce`: PDF opens
in Scient's PDF reader instead of a save dialog). Work log and reasoning start off on every opening, the range is the whole
conversation or up to a chosen message, and the text-only or `.zip` choice appears only when the
conversation has attachments. The dialog warns when work log or reasoning is included and when a
turn is running; the file's own warnings are shown after export and written into the file.
