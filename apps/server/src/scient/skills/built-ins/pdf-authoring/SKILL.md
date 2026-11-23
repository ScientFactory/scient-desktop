---
name: pdf-authoring
description: PDF output. Make, edit or export a PDF of my paper, report, poster, grant, handout or form, including Markdown and HTML-to-PDF. Use latex-authoring for writing or troubleshooting .tex. Use pdf-files, when available, to read or work directly on an existing PDF.
---

# PDF authoring

Deliver the saved PDF, checked against what was asked for in content and layout, together with its editable source. If a build or the visual check can't be done, say which and give the useful files you have.

## Source

Keep the document's existing editable format and design. HTML builds with `scient_pdf_build`, Markdown exports with `scient_document_export`, and LaTeX builds with `scient_latex_build` (load `latex-authoring` for source work). For HTML print layout, read this skill's `references/html-print.md`.

To change a PDF's content, edit its source and rebuild; an existing PDF is not an HTML build input. For page operations or form filling, work on the PDF itself with a library such as `pypdf` in Scient Compute and write a new file, keeping the text and structure as they are rather than retyping or rasterizing; check that links, form fields, bookmarks, selectable text and untouched pages survive. If a text edit needs a source you don't have, say so.

Builds and exports write to `outputPath` and replace what is there, so choose it deliberately. A request only to check a PDF needs no rebuild or export; rendering page images in a temporary folder to look at them is fine.

## Check before finishing

1. Confirm the build wrote the PDF at the returned `outputPath` and read every warning. An open preview tab is not proof of a built file.
2. Check the page count against any limit, and that every section, figure, table and equation survived. Fix missing images and blocked assets, or name what is missing. Fit pages with all content kept and type at readable size.
3. Render the pages to images and look at them (`references/visual-check.md` has the commands and `scripts/render_pdf.py`). Look at every page of a short document; for a long one, the changed pages, page breaks and each distinct layout, and say which pages you skipped. Rebuild and look again after fixes.
4. Check what readers will notice: labels readable at print size, clipped tables, equations, glyphs, citations and cross-references. When the venue requires it, also check links, font embedding, image resolution and tagging; appearance alone doesn't show accessibility.

Reply with links to the PDF and its source, the page count, the pages you inspected, warnings and anything unfinished. If you couldn't look at the pages, say "visual inspection not performed" and why, and call the PDF unchecked.
