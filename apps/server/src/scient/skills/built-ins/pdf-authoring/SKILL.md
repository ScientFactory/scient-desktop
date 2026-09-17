---
name: pdf-authoring
description: Create, revise, or export PDF documents in Scient. Use when the user asks to create a PDF, change an existing PDF, or export another document as PDF. Do not use when the task only involves reading or extracting information from a PDF.
---

# PDF Authoring

The goal is to deliver a PDF that meets the user’s requirements and accurately report what was produced and verified.

## Choose a Method

Honor any format or editing method the user requests. When working from an editable source, preserve its format unless the user requests conversion or conversion is required to complete the task.

Choose the method based on the requested changes, available source, future editing needs, and the tools available:

- For an existing PDF, use direct PDF operations when they can make the requested changes while preserving the rest of the document.
- When authoring a document without an established source format, consider LaTeX for structured typesetting such as equations, citations, and cross-references, or HTML and CSS for browser-based layout and graphics.
- Consider other available authoring, export, or PDF-editing tools when they better fit the task.

Use the relevant dedicated skill and tools available for the selected method. Use `latex-authoring` for LaTeX and `html-pdf-authoring` for HTML-to-PDF; follow equivalent guidance for other methods when available.

## Produce and Verify the PDF

This skill grants no tools or authority. When the requested deliverable is a PDF, source alone is not completion: produce the actual PDF using an available build, export, or editing capability. If that cannot be completed, provide any useful work produced and clearly explain what remains.

Review the output against the requirements that matter for that document, including content completeness, readable layout, relevant text fidelity and navigation, and any explicitly requested page count.

Successful generation or editing does not establish visual quality. When visual review is available, inspect rendered pages of the resulting PDF. Prefer direct page rendering or a PDF preview tool over computer use when it provides the needed view. Inspect enough of the document to support the claims you make, fix material defects you observe, and verify the updated output. If visual inspection is unavailable, say so.

When reporting completion in Scient chat, provide clickable project-relative Markdown links to the final PDF and any editable source created or updated. Use the actual output path; when a tool returns `outputPath`, use it for that tool’s output. Wrap destinations containing spaces in angle brackets. If no PDF was produced, link any useful work created and state what remains. Briefly report what was verified and any material limitation.
