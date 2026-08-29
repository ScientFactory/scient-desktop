---
name: pdf-authoring
description: Create polished PDF deliverables and their editable sources. Use when the user asks to create, revise, or export a PDF or printable document, not when they only want to read an existing PDF.
---

# PDF Authoring

The goal is to produce a correct, polished PDF that fits the user's purpose while preserving an appropriate editable source and truthful build evidence.

## Choose an Authoring Route

Honor the user's requested source format. If they ask for LaTeX or a `.tex` source, create LaTeX and do not substitute HTML merely because HTML has a direct build tool. Preserve an existing authoring format unless the user asks to convert it.

When the user has not chosen a format, select the source model whose strengths match the document's hardest requirements and expected revision workflow, not its topic or length alone:

- Prefer LaTeX when semantic typesetting—such as equations, references, numbering, footnotes, or consistent structured composition—is the main source of complexity.
- Prefer HTML and CSS when visual composition, browser-native graphics, multilingual or RTL behavior, or web-derived content is the main source of complexity.
- When neither dominates, use the route that can be built, inspected, and maintained most reliably with the capabilities actually available.

When LaTeX is chosen, use `latex-authoring` when available. When HTML is chosen for PDF output, use `html-pdf-authoring` when available. Preserve another existing source format and use its qualified native exporter when that gives the most faithful result.

These are judgment criteria, not restrictions. Do not re-render an existing PDF merely to copy, inspect, or transform it; use a PDF-native operation when one is available.

This skill provides guidance only and grants no tools or authority. If no qualified build route is available, provide the editable source and state the limitation clearly; never imply that a PDF was produced or verified.

## Build and Verify the Deliverable

Keep the source and its assets in sensible workspace locations unless the user requests otherwise. When the requested deliverable is a PDF, source alone is not completion: build the PDF when the session has a qualified route.

Review the result in the dimensions that matter for the document:

- visual fidelity, including typography, hierarchy, spacing, pagination, sharp figures, and the absence of clipping, overlap, or missing glyphs;
- text fidelity, including search, selection, copy order, and RTL or mixed-direction text when relevant; and
- document behavior, including page count, links, outline, references, and page numbering when intended.

Inspect rendered pages rather than relying only on successful compilation or structural parsing. Review every page of a short document and representative high-risk pages of a long one. Fix meaningful defects and rebuild when possible.

Link the editable source and the final project PDF when one was actually produced. Use project-relative Markdown links, wrap link destinations containing spaces in angle brackets, and link the exact `outputPath` returned by a build operation. If no PDF was built, link the source and state that limitation clearly. Do not rebuild through another route merely to obtain a clickable link. Then report the authoring route, verification performed, and any unresolved warning or unverified property.
