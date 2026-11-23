---
name: word-docx
description: "Make me a Word document, edit this .docx, add tracked changes or comments, tell me what this Word file says, use this .dotx template, or convert an old .doc. Use google-workspace for live Google Docs, pdf-authoring for PDF delivery, and document-review for manuscript critique. Use word-docx to record that review in Word."
---

# Word documents

Deliver a Word file that preserves the source features the task depends on. Validate the package and inspect the rendered pages before handoff.

Call `scient_document_runtime` in this thread. When it returns `ready`, set the shell variables below to the returned paths. Run the commands from the workspace, with local input and output paths. An unavailable runtime leaves the corresponding checks unverified.

```sh
PY='<pythonPath>'
TOOLS='<toolsPath>'
DOC="$TOOLS/doc.py"
export PATH='<nativePathPrefix>':"$PATH"
```

1. **Decide whether to open the input.** Before inspect, text extraction, conversion, rendering or other parsing, establish where each input came from and whether it is trusted. Run untrusted inputs in a disposable, network-denied worker with resource limits and access only to job files. The preview tools do not provide that isolation. If a worker is unavailable, report which checks or deliverables are blocked. Apply the [package preflight](references/edit-ooxml.md#preflight-and-unpack) to OOXML before using direct helpers.

   **Done when** each input has a recorded trust decision and an available execution route, or is left unopened with the blocker reported.

2. **Choose a route.** Run `"$PY" "$DOC" probe` and check the dependencies. Rendering needs LibreOffice and Poppler.

   | Request                          | Route                                                                                                                                                                  |
   | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Create a Word document           | Use python-docx with the runtime interpreter. Read [create-python-docx.md](references/create-python-docx.md).                                                          |
   | Edit a Word document             | Run `"$PY" "$DOC" inspect INPUT.docx`. Use verified plain-text `w:t` nodes or targeted OOXML as described in [edit-ooxml.md](references/edit-ooxml.md).                |
   | Accept or reject tracked changes | Use `accept_changes_xml.py` on a copy of the original and check the revision report. Follow the [revision workflow](references/edit-ooxml.md#resolve-tracked-changes). |
   | Read a Word document             | Use `"$PY" "$DOC" text INPUT.docx` for comprehension and `inspect` for structure. Read the relevant XML for exact anchors, fields, or revisions.                       |
   | Work with an old `.doc`          | Run `"$PY" "$DOC" convert INPUT.doc converted.docx`. Verify the conversion against the source and use it as the edit baseline.                                         |
   | Use a `.dotx` template           | Keep the template intact and work from a document instance. See [template setup](references/create-python-docx.md#word-templates).                                     |

   **Done when** the route and required tools are confirmed. For read-only requests, stop once the answer is grounded in the inspected content and any extraction gaps are reported.

3. **Preserve the baseline.** Keep the original for validation and render comparison. On edits, inventory its features with `"$PY" "$TOOLS/ooxml/docx_feature_inventory.py" ORIGINAL.docx` and record the intended count changes. When a document has headings and the outline looks incomplete, check the paragraphs and their styles for `w:outlineLvl`. Preserve sections, page size, margins, and named fonts. For a new file, use the requested or template layout, or choose A4 or US Letter for the audience and report the choice. Read [scientific-documents.md](references/scientific-documents.md) for equations, citation fields, numbered captions, journal templates, or coauthor redlines.

   **Done when** the original is available, the layout is recorded, and the intended edit and feature-count changes are listed.

4. **Write the output.** Find the edit in the original XML across run boundaries. If useful, run `merge_runs.py` on a disposable search copy and map the match back to the original structure. Write the edit into a fresh copy of the original package. Use targeted OOXML for redlines and comments. Add the range markers and reference for each new top-level comment, verify the metadata for replies, and use the requested author or report the label used. When combining plain edits, comments and redlines, follow the [walkthrough](references/edit-ooxml.md#walkthrough-for-a-plain-edit-comment-redline-and-accepted-copy) and keep a copy after each stage.

   **Done when** the saved file contains the intended text and review objects at the requested locations.

5. **Repair zoom and check the saved package.**

   ```bash
   "$PY" "$TOOLS/ooxml/docx_fix_zoom.py" OUT.docx
   "$PY" "$DOC" validate OUT.docx
   "$PY" "$DOC" validate OUT.docx --original ORIGINAL.docx
   "$PY" "$DOC" validate REDLINED.docx --original PRE_REDLINE.docx --author "Name"
   "$PY" "$TOOLS/ooxml/docx_feature_inventory.py" --compare ORIGINAL.docx OUT.docx
   ```

   Run the zoom repair on new python-docx outputs. Choose the validation form for creation, edits or newly added tracked edits. `--original` lets validation distinguish new defects from [matching baseline defects](references/edit-ooxml.md#validate-against-the-original). For `--author`, use the saved copy immediately before the redline, after any plain edits and comments, and check the new revisions' `w:author` and ranges in the XML. Run the inventory comparison for every edit. Add one exact signed `--allow kind=delta` per verified intentional loss. Inspect feature deltas, part changes and registrations against the edit plan. Check the contents and links of affected features as well as their counts.

   **Done when** the applicable checks pass, each requested or affected feature has been verified in the saved output, and any remaining verification gap is named.

6. **Render and review.** Run `"$PY" "$DOC" render OUT.docx --out FRESH_DIR --pdf` and open every page image. The Document Lab render profile displays native OMML equations. Check page breaks, headings, tables, equations, images, headers and footers. On edits, compare with the baseline render. For a clean copy, compare against the all-accepted or all-rejected view for the requested mode. Check review markup in the XML and use Word when its display or field behavior is part of the request.

   **Done when** the page count and pages viewed are recorded, layout issues are resolved, and the outcome of Word-specific checks is recorded. If no pages could be viewed, report “visual inspection not performed” with the reason.

7. **Hand off.** Link the output and any requested clean derivative. Report the layout basis, validation and feature checks, the number of pages viewed, whether Word-specific behavior was checked, and any conversion loss or verification gap.

   **Done when** the handoff identifies the file to use and gives the status of each applicable check.
