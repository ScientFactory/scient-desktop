---
name: html-pdf-authoring
description: Create or modify HTML specifically to produce a high-quality PDF with Chromium. Use only when PDF or printable output is the purpose of the HTML work, not for ordinary webpage creation or editing.
---

# HTML-to-PDF Authoring

The goal is to create or adapt HTML whose Chromium-generated PDF is visually polished, textually usable, and faithful to the user's purpose, while keeping the HTML an editable source.

Use this guidance only when HTML is being created or modified specifically to produce a PDF or printable document. Do not apply it to ordinary webpage work.

## Design for Pages

Understand the document's audience, content, and intended paper size before styling. Honor an existing design and source structure. When adapting an existing page, prefer a narrow print layer over rewriting its screen behavior unless the user asks for a redesign.

Treat page count as a pagination outcome, not as a collection of fixed-height canvases. Start from normal document flow and use page-break controls as guidance. Use rigid page canvases only when the requested format genuinely requires them and the exported PDF has been verified.

Choose page size, orientation, and physical margins deliberately and express them with `@page`. Do not silently assume A4 or Letter when the choice could change the result. Use ordinary layout styles for typography and content spacing; do not recreate the same page margins with print-visible body or wrapper spacing. Use `@media print` only where the printed document needs to differ from the normal HTML, and confirm that it does not hide meaningful content.

## Preserve Document Meaning

Use semantic headings in a logical hierarchy, real links, lists, figures with captions, and native tables with header and body structure. These preserve document meaning and support useful outlines, links, accessibility, and later inspection. When the document itself includes links, use semantic HTML anchors and verify that the intended links remain clickable in the exported PDF. Set the document language and use `dir` on the document or relevant sections for RTL and mixed-direction content.

Keep assets stable and workspace-relative. Give images useful intrinsic dimensions, ensure fonts cover every required glyph, and prefer SVG or HTML and CSS for diagrams and charts that should remain sharp. Avoid depending on slow or transient remote assets. Canvas, WebGL, video, embedded frames, virtualization, and lazy content may flatten, omit, or destabilize output; use static alternatives when fidelity matters.

## Control Fragmentation Carefully

Use `break-before`, `break-after`, `break-inside`, `widows`, and `orphans` to guide Chromium, not to simulate a rigid page editor. Keep short figures, rows, code blocks, and headings with their related content when practical. Do not forbid breaks inside content taller than a page; it must remain able to fragment without clipping or creating large blank areas.

Page counters and margin-box content may be used only when the actual Chromium export verifies them. Do not rely on automatic CSS footnotes, running strings, or target-based page cross-references. Author stable visible footnotes or endnotes instead, or choose LaTeX when those publishing features are central.

## Export and Verify

If `scient_pdf_build` is available, call it with the project-relative HTML source path and intended project-relative PDF output path. Scient renders the document with print media in isolated Chromium, permits its local sibling assets, blocks remote resources, validates the PDF structurally, publishes an immutable revision, writes the validated PDF to `outputPath`, and opens it. Tool success does not prove visual quality. If direct build access is unavailable, create and link the workspace HTML so the user can open it in Scient and choose Export PDF. This skill grants no tools or authority, and source creation alone is not a completed PDF.

Judge the exported PDF, not only the browser page. Check representative page boundaries and every page of a short document for blank pages, clipping, overlaps, awkward breaks, missing glyphs, and weak visual hierarchy. Verify page size and count, selectable text and logical copy order, RTL where relevant, actual clickable link annotations and outline, font rendering, and image or vector sharpness. Fix meaningful defects and export again when possible.

When reporting completion to the user in Scient chat, provide clickable project-relative Markdown links to the exact editable HTML source and the final PDF at the returned `outputPath`. Wrap link destinations containing spaces in angle brackets. If no PDF was built, link the HTML source and state that clearly. Do not rebuild through another route merely to obtain a link. Then report what was verified and any unresolved warning or untested property.
