---
name: document-review
description: "Review this manuscript, report, deck or workbook before I send it, or mark issues in the file. Use the format skill for edits and reviewer-response for a reply to reviewers. For a single check, use references for citations, check-reported-numbers for reported values, statistics-review for methods, or reporting-guideline-check for reporting compliance."
---

# Document review

Return a findings report with exact locations and evidence by default. Add native review marks on request. Mark a separate copy for local files unless the user requests in-place markup.

For a local file, call `scient_document_runtime` in this thread. When it returns `ready`, set the shell variables below to the returned paths. Run the commands from the workspace, with local input and output paths. Use this preview for trusted fixtures. An unavailable runtime leaves the corresponding checks unverified.

```sh
PY='<pythonPath>'
TOOLS='<toolsPath>'
DOC="$TOOLS/doc.py"
export PATH='<nativePathPrefix>':"$PATH"
```

1. **Inspect.** Use `"$PY" "$DOC" inspect FILE` and the relevant format skill for local Office and PDF files. Use `google-workspace` for native Docs, Sheets and Slides. Read Markdown and LaTeX source directly. Record the revision or file inspected, its sections, sheets, slides or pages, and any existing comments or changes. Apply the scope the user gave. Done when the review has a known baseline and a list of applicable checks.
2. **Read the rendered document.** Run `"$PY" "$DOC" render FILE --out NEW_DIR` for Office or PDF. For a Google file, use the connector export and render the resulting PDF. For Markdown or LaTeX, inspect the compiled document when layout is in scope. Open all pages of a short document. For longer files, cover changed pages, pages with findings and every distinct layout, and record the pages inspected. Use extracted text or structured reads for precise locators. Done when each inspected layout and any rendering gap is recorded.
3. **Check the scientific claims and document structure.** Load the Scient skills that apply to the scope. Use `references` for citation support, `check-reported-numbers` for values against project evidence, `statistics-review` for the methods and inference, and `reporting-guideline-check` for the study's reporting checklist. Check applicable cross-references, units, table and figure labels, and readability. Require the actual data table or result for a numerical check. A callout or caption can locate the evidence, and a missing table is an evidence gap. Use one ledger row per occurrence, with the exact excerpt, location, contrast and evidence, even when several passages repeat the same number. List every conflicting prose location in a precision finding. For workbooks use `excel-xlsx` to inspect formulas and verify recalculation on a copy. Done when each applicable check has a result or a named evidence gap.
4. **Write findings.** Put issues that could change a conclusion or block submission first. Give each finding an exact locator and a short searchable excerpt, the issue, the evidence and an actionable suggestion. Use page + section, slide + object, or sheet + range. Give a source and page for a citation finding and the two values plus the output location for a numerical discrepancy. Include checks without findings and checks that could not run. If no render was viewed, write “visual inspection not performed” and give the reason. Done when each finding can be located and checked independently.
5. **Add and verify requested review marks.** Inventory existing comments, threads and revisions, then read back the prior and new review objects after editing. Never accept, reject, resolve or delete someone else’s marks without an explicit request. Keep the original text during review, and use a visible suggestion for proposed changes.
   - **Word:** use `word-docx` for range comments on the smallest meaningful span and tracked changes when requested. Validate against the original and verify the marks after reopening. Read [the comments-only example](references/comments-only.md) when the review must preserve every existing Word edit and field.
   - **Google Docs, Sheets and Slides:** use `google-workspace` for comments where supported. Treat API-created comments as unanchored. Start the body with the tab or slide, section, range or element and a searchable excerpt. Read back prior and new comments to confirm the intended file and locators.
   - **Excel:** Inventory legacy cell notes and threaded comments, including their locations and authors. Use the OOXML editing route in `excel-xlsx` for preservation-sensitive markup. An openpyxl save can clear cached formula results and drop workbook features. Read back prior and new review objects, then compare workbook parts, formulas, cached results and features with the baseline. Preserve any existing note or thread on a target cell and keep the new finding in the report unless the user requests an update. Keep all findings in the report if preservation cannot be demonstrated.
   - **PDF:** write a separate annotated copy using page annotations with the issue and exact location in each annotation. Reopen to verify page, rectangle and contents, and check the corresponding page images.
   - **PowerPoint, Markdown and LaTeX:** use the report’s locators where reliable native review objects are unavailable. Add PowerPoint speaker notes only on request.

   Done when each finding either maps to a verified review mark or is identified as report-only.
