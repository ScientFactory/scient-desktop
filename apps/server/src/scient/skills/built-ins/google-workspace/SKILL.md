---
name: google-workspace
description: "Find or manage a file in Drive, read or edit a native Google Doc, Sheet, or Slides deck, add or embed a chart, reply to comments, or export a native file. Use for requests to create a native Google file or import a file into Drive. Route Office authoring by MIME type to word-docx, excel-xlsx, or powerpoint-pptx, including binaries stored in Drive. Use pdf-files for work on an existing PDF."
---

# Google Workspace

Deliver the requested read, change, new file, or export and verify it at the
destination the user asked for.

## Steps

1. **Choose the operation and destination before any mutation.** Decide whether
   the request is a read, export, metadata change, comment, suggestion, in-place
   edit, creation, copy, or import. An edit keeps the original Drive file ID.
   Create, copy, or import only when the requested output authorizes a new file.
   Apply this to template copies and chart-source workbooks too. For each new
   file, establish its type, title, and destination folder when specified.
   `update_file` handles rename/move through metadata. Supplying `file_uri`
   replaces stored-file bytes and requires a request to replace those bytes.
   Done when the operation and every destination are known.

2. **Confirm file identity and the required tools.** Use the given URL or ID,
   keeping any Docs tab parameter. Otherwise locate the file with
   `google_drive.search` and disambiguate using `get_file_metadata` (MIME type,
   title, owner, parent, or modified time). Ask if the target remains ambiguous.
   Native Docs, Sheets and Slides have MIME types ending in
   `vnd.google-apps.document`, `vnd.google-apps.spreadsheet`, and
   `vnd.google-apps.presentation`. A Drive-hosted Office binary goes to the
   matching format skill for content work. Use Drive tools for Drive operations.
   Check only the connector actions the chosen operation needs. When an
   in-place edit needs an unavailable editor action, report the capability gap
   and preserve the original destination. Reads can succeed while writes fail
   with `ACCESS_TOKEN_SCOPE_INSUFFICIENT`: treat that as "reconnect Google
   Drive with edit access", ask the user, and stop the write path.
   Importing a local file (`import_document`/`import_spreadsheet`/
   `import_presentation`) needs a file the host uploaded (user attachment);
   a workspace path is rejected (`download_url is not allowed`). Without an
   upload, create the native file and write typed cells or requests instead.
   Done when each existing file has a confirmed ID and type and the needed
   actions are available, or the exact blocker is known.

3. **Read at the fidelity the operation needs.** Metadata and export-only tasks
   skip structured editor reads and runtime probes. Use bounded content reads
   for answers and structured reads for write scope. Load the applicable
   references before planning editor changes.

   | Task                                    | References                                                                                                  |
   | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
   | Docs text, structure, or suggestions    | [docs.md](references/docs.md)                                                                               |
   | Sheets values, formatting, or structure | [sheets.md](references/sheets.md)                                                                           |
   | Slides text, layout, or images          | [slides.md](references/slides.md)                                                                           |
   | Sheets chart                            | [sheets.md](references/sheets.md) and [charts.md](references/charts.md)                                     |
   | Embed or refresh a chart in Slides      | [sheets.md](references/sheets.md), [charts.md](references/charts.md), and [slides.md](references/slides.md) |

   For comments, page through `get_file_comments` using each `nextPageToken`
   as `page_token`. Find the target thread or read enough content to locate the
   new comment precisely. For edits, identify the tab, segment, cell range or
   object and take a baseline of the affected content and its neighbours.
   In Docs verify destructive ranges against a structured read. The Docs
   reference covers tab-wide operations and suggestion capability.
   Done when the baseline identifies every target and its expected change.

4. **Apply the scoped operation.** Use one batch per logical editor change.
   For Docs and Slides, pass `write_control.requiredRevisionId` from a fresh
   read under the same account. A stale revision returns HTTP 400. Re-read
   and recompute after a conflict or before computing positions for another
   batch. Sheets has no `writeControl`. Read the exact cells just before
   writing and keep the write narrow. A collaborator can still change cells
   between those calls.

   Use narrow dotted leaf paths for update masks, such as
   `userEnteredFormat.textFormat.bold`, since broad paths or wildcards can
   clear omitted fields. A read-side partial-response `fields` selector
   chooses returned data and can use nested selections where supported.

   For local images, check the available Docs or Slides batch tool's
   `image_uris` sidecar and match each path to its request placeholder in
   order. For remote images use a URL Google can fetch at request time.
   An import-based image workflow requires an authorized new destination.

   Use `bulk_update_file_comments` to reply by `comment_id` or to create a
   comment with a precise locator in its body. Include tab and exact text for
   Docs, sheet title and A1 range for Sheets, or slide number and target text
   or object for Slides. Drive API comments appear unanchored in editors.
   Claim a native anchor only if an editor read confirms one. Resolve only the
   requested threads.

   After an ambiguous timeout, check whether the original operation took
   effect before retrying. For create/copy/import look in the destination for
   the new file and verify its identity and content. For append/insert check
   the target and counts. For comments check thread IDs, content, and state.
   If a response reports partial failure, inspect available per-operation
   results, including `commentAndSuggestionUpdateStatus` where returned.
   Retry only effects confirmed absent. If the outcome stays ambiguous,
   report it before taking an action that could duplicate the change.
   Done when each requested mutation is accounted for against its destination.

5. **Verify the result.** Re-read the original ID for an edit or the returned
   ID for a new file. Compare the specific tab/range/object, counts, and
   neighbours against the baseline and intent. Revision movement alone cannot
   establish which write landed. For comments, verify the posted text, reply,
   or resolution under its thread ID. For metadata, read the changed fields.

   For document, sheet, and deck content changes, inspect the affected pages,
   sheets, or slides. Use slide thumbnails or a PDF export. For a requested
   export, verify the returned file type and inspect the PDF when available.

   - Call `export_file` with `mime_type: "application/pdf"`. It returns a
     user-scoped file reference. If the host materializes it, use the returned
     absolute path. Otherwise download the returned attachment through the
     authenticated host file UI into the workspace and use the saved path.
     An opaque `file_uri` by itself is insufficient for a shell command.
     If the host offers neither route, report that the reference could not be
     materialized locally.
   - Drive's export endpoint limits output to 10 MB. Where supported, use
     `fetch(url=..., download_raw_file=true, raw_export_mime_type="application/pdf", include_base64=false)`
     to request a streamed file reference and materialize it the same way.
   - For a local PDF, use `pdftoppm -png exported.pdf <output-prefix>` or
     `"$PY" "$DOC" render exported.pdf --out <dir>` (also uses Poppler's
     `pdftoppm`). Open the relevant rendered PNGs. Define `PY`, `DOC` and
     `GW` from the runtime paths below only when using the local helpers. If no
     visual route works, report “visual inspection not performed”, why, and
     which read-back checks passed.

   Done when each requested result has been checked and any unavailable
   verification is identified.

6. **Link and report.** Link the relevant Drive files and requested artifact.
   State what changed by tab, range, heading, or slide, or answer the read
   request. Include any partial updates or verification gaps.
   Done when the user can open the exact result and tell what was verified.

For local helpers on trusted fixtures, call `scient_document_runtime` in this thread. When it returns `ready`, set the shell variables below to the returned paths. Run the commands from the workspace, with local input and output paths. An unavailable runtime leaves the corresponding checks unverified.

```sh
PY='<pythonPath>'
TOOLS='<toolsPath>'
DOC="$TOOLS/doc.py"
GW="$TOOLS/gw.py"
export PATH='<nativePathPrefix>':"$PATH"
```

API references for [Docs requests](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request),
[Sheets batches](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate),
and [Drive comments](https://developers.google.com/workspace/drive/api/guides/manage-comments).
