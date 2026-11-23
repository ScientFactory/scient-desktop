---
name: google-workspace
description: "Find or manage files in Drive. Create, read, edit, comment on or export native Google Docs, Sheets or Slides, including charts. Use the matching Office skill for .docx, .xlsx or .pptx files stored in Drive."
---

# Google Workspace

Deliver the requested change, file or export at its intended destination. A
native in-place edit keeps the same Drive file ID.

1. **Confirm the file and operation.** Use the given URL or ID, including any
   Docs tab selector. Otherwise disambiguate by title, MIME type, owner or
   parent. Create, copy or import when the requested output calls for a new
   file. Use Drive metadata actions for renames and moves. A replacement upload
   changes stored bytes. Route Office binaries to their matching format skill.
2. **Find the editor tools.** A Drive connector may be able to find or copy a
   Sheet and provide no tool for editing its cells. Check for the needed read
   and write actions before starting a native edit. On
   `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, stop that write and identify the action
   that needs edit access. A connector import requires a supported uploaded
   file reference. A workstation path by itself may be rejected.
3. **Plan and apply the edit.** Read just enough structure to identify the
   action and its boundaries. Use the applicable reference for editor requests
   and keep update masks on the specific fields you intend to change.

   | Task                                 | Reference                                                          |
   | ------------------------------------ | ------------------------------------------------------------------ |
   | Docs text, structure, suggestions    | [Docs](references/docs.md)                                         |
   | Sheets values, formatting, structure | [Sheets](references/sheets.md)                                     |
   | Slides text, layout, images          | [Slides](references/slides.md)                                     |
   | Create, embed or refresh a chart     | [Charts](references/charts.md) and the applicable editor reference |
   | Visual review or export              | [Visual checks](references/visual-checks.md)                       |
   - **Sheets.** Confirm the tab's numeric ID, range and requested fields.
     Build a diff of intended writes and check it against that scope. Use
     typed values or `RAW` for literal text such as `007`, dates spelled out
     as text, and strings beginning with `=`. Use intentional formulas and
     numbers as their own types. Use `USER_ENTERED` when Sheets should parse
     the input in the spreadsheet's locale. Re-read the target just before a
     shared-sheet write. Hidden or filtered rows still have grid coordinates.
   - **Docs and Slides.** Get positions or object IDs from an editor read.
     Use a fresh required revision ID when the tool supports it. Re-read and
     recompute positions after a stale-revision response.
   - **Comments.** Page through threads to find the exact comment. Reply or
     resolve by ID. For a new Drive comment, include a precise text locator,
     cell range or slide in the body. Verify a native anchor in the editor
     before reporting that one exists.
   - **Retry.** After a timeout, read back the original destination before
     retrying creates, copies, appends, inserts or comments. Retry only effects
     confirmed absent and report any ambiguous result.

4. **Reopen and verify.** Compare the actual change with the intent at the
   original ID or the new file's returned ID. For Sheets, read back stored
   values, formula definitions, calculated results and the affected format
   fields. Check the relevant neighbors and any known dependents. Check
   row/column metadata when height, width or hiding is in scope. Name the
   properties and ranges checked. Use a visual check for appearance or print
   layout. For other operations, check the changed metadata, comment state,
   document content or export. Link the result and identify any verification gap.
