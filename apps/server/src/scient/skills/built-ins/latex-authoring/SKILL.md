---
name: latex-authoring
description: LaTeX and .tex files. Write or edit LaTeX; compile my paper; fix LaTeX errors, missing citations, equations or figures. Use overleaf-sync for transferring or resolving synced files, and pdf-authoring for other PDF formats. An Overleaf mention alone is not a sync request.
---

# LaTeX authoring

Deliver source that still builds and stays maintainable and, when compiling was asked for or is needed to verify a fix, a built PDF you have looked at. For source-only work, say whether you compiled.

Keep the document's class, engine, bibliography system and file structure, and work from its real root file. When a package or font is missing, report what is missing and keep the engine and journal class as they are.

## Citations and content

Cite only with keys from the project's bibliography or from verified source records; every BibTeX entry you add is copied from a record, never written from memory. For new citations in a Library-managed bibliography, add the source to the Library and cite it from there; for a hand-maintained `.bib`, copy the details from the registry or publisher record into that file, keeping it hand-maintained. A key that compiles is not evidence for its sentence; load `references` to check support.

When you change equations, symbols, units, numbers or labels, compare them with what the researcher gave you, and keep the argument as it was. Check figure paths (exact case and extension) from the root, and that every command you add has its package loaded.

## Build and look

Compile with `scient_latex_build` from the real root. Fix undefined citations and references and missing files even when a PDF was produced, look at overfull boxes, especially in two-column layouts, and confirm the PDF is where the result says.

Then render the pages to images and look at them: `pdftoppm` if it is installed, otherwise `pdf-authoring`'s `scripts/render_pdf.py` and `references/visual-check.md` (read them with `scient_skill_read_resource`). Look at every page of a short document; for a long one, the changed pages, page breaks and each distinct layout, and say which you skipped. Check figures, tables, equations, glyphs and cross-references, and rebuild and look again after fixes. A clean log doesn't show the page; if you couldn't look, say "visual inspection not performed" and why.

For a journal or arXiv submission, check that venue's current instructions (engine, bibliography output, packages, file layout).

Reply with links to the PDF and each edited source, the page count from the latest build, the pages you inspected, the remaining warnings and anything unfinished. If the toolchain is blocked, name the missing engine, package or font.
