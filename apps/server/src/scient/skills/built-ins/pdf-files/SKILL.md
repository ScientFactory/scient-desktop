---
name: pdf-files
description: "Read or extract from a PDF, split, merge or rearrange existing PDF pages, add a page overlay, or fill or flatten a PDF form. Use pdf-authoring for a PDF built from source and latex-authoring for LaTeX source."
---

# PDF processing

Return the requested extracts or a checked derivative PDF. Keep the input as the baseline.

Call `scient_document_runtime` in this thread. When it returns `ready`, set the shell variables below to the returned paths. Run the commands from the workspace, with local input and output paths. An unavailable runtime leaves the corresponding checks unverified.

```sh
PY='<pythonPath>'
TOOLS='<toolsPath>'
DOC="$TOOLS/doc.py"
export PATH='<nativePathPrefix>':"$PATH"
```

1. **Inspect the input.** Use the local preview for trusted fixtures. Run `"$PY" "$DOC" inspect file.pdf`. Check page count, text-layer coverage, `acroform_fields` and encryption. If inspection fails on a locked file, identify encryption with `PdfReader.is_encrypted` and use authorized access before inspecting pages. Inspect page widgets as well as the field tree before routing a form. Done when you know which pages have readable text and whether the input is accessible and interactive.
2. **Choose the operation.** For encrypted input, read [the protected-PDF reference](references/protected-pdfs.md) before an edit or conversion.
   - For text, tables or images, read [the extraction reference](references/extract.md). Use rendered pages for image-only or unreadable text layers, and verify any OCR or transcription against the image.
   - For forms, read [the form reference](references/forms.md).
   - For page edits, use pypdf or qpdf. Use page rotation metadata and preserve selectable text. Write to a new path. After splitting or reordering, resolve each retained internal link and bookmark through named or direct destinations to a page in the new page tree. qpdf can copy an outline whose target pages were dropped. Read [the subset example](references/page-subsets.md) when retaining navigation or widgets.
   - For an overlay or watermark on an existing page, build the overlay with ReportLab Canvas for fixed layout or Platypus for flowing content and merge it onto a copy. In a Platypus Paragraph, use `<sub>` and `<super>` for subscripts and superscripts. For CJK, use a font with TrueType outlines and glyph coverage. ReportLab `TTFont` rejects CFF/PostScript outlines even in a font covering the right characters. Check rendered glyphs and extracted text.

   Done when the extraction has page locators or the requested operation has produced a new PDF.

3. **Reopen and look.** For an unprotected derivative, run `"$PY" "$DOC" validate out.pdf` and `"$PY" "$DOC" render out.pdf --out NEW_DIR`. For a protected derivative, use the password-aware checks in the reference. Reopen with pypdf, compare page count, order, retained structures and form values as applicable, and open the page images. Inspect every page of a short file and at least all changed and boundary pages of a long one. For extraction, compare the result with the rendered source. Done when data and visible output agree with the request, with limits recorded.
4. **Deliver.** Link the files and state the pages inspected and any incomplete checks. If images could not be inspected, write “visual inspection not performed” and give the reason. Done when each deliverable and its verification status are clear.
