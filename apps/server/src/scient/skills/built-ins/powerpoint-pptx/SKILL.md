---
name: powerpoint-pptx
description: "Make me a PowerPoint deck, edit these .pptx slides, follow this PowerPoint template, or read this deck. Use google-workspace for native Google Slides and document-template to turn a reference deck into a reusable skill."
---

# PowerPoint

Return a checked .pptx for creation or editing. For reading, return the requested content with slide numbers.

Call `scient_document_runtime` in this thread. When it returns `ready`, set the shell variables below to the returned paths. Run the commands from the workspace, with local input and output paths. An unavailable runtime leaves the corresponding checks unverified.

```sh
PY='<pythonPath>'
TOOLS='<toolsPath>'
DOC="$TOOLS/doc.py"
export PATH='<nativePathPrefix>':"$PATH"
```

1. **Choose the route.** Use the local preview for trusted fixtures. Create with pptxgenjs after reading [the creation reference](references/create-pptxgenjs.md). Edit a copy or fill a supplied template using [the editing reference](references/edit-and-templates.md). For reading, run `"$PY" "$TOOLS/ooxml/slide_text.py" deck.pptx`. It extracts slide text, tables, chart data and notes. Render the relevant slides when the request depends on figures or layout. Done when the read answer has slide locators or the requested .pptx exists.
2. **Check slide content.** Run `slide_text.py` on the result. Search the dump with `rg -in 'click to add|lorem ipsum|TODO|replace with your' slides.txt` and add prompts specific to the template. Confirm titles, chart values, notes and slide order against the brief. Done when each match is resolved and every expected slide is accounted for.
3. **Validate the package.** Run `"$PY" "$DOC" validate out.pptx`. For edits, add `--original original.pptx` using the source deck. Read the diagnostics, including per-plot axis and stacked-label checks, and distinguish inherited faults from new ones. Done when no new validation errors remain and any inherited errors are recorded.
4. **Render and look.** Run `"$PY" "$DOC" render out.pptx --out NEW_DIR`. Open new or changed slides and inspect overflow, overlaps, alignment, contrast and chart legibility. For a notes-only edit, compare slide, master, chart and media parts against the original and read back the notes on the exact slide. Render when the package or task gives a reason to check the visible slide. Check that native charts in the package also appear in the images. If any expected chart is missing, use the [trusted-fixture render fallback](references/create-pptxgenjs.md#check-native-charts) and compare its bars or points and labels with the chart cache and embedded workbook. Check the image count against the deck and account for hidden slides. Fix and rerender. Done when the affected slides are checked and remaining visual gaps are reported.
5. **Deliver.** Link the deck and give its slide count, size and pages inspected. Name font substitutions and any unchecked features such as animations or transitions. Report PowerPoint compatibility as “unchecked until opened in PowerPoint” when you verified the deck in a different viewer. If the images could not be inspected, write “visual inspection not performed” and give the reason. Done when the user can tell which checks ran and which still need a viewer.
