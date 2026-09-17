---
name: latex-authoring
description: Create or modify LaTeX documents in Scient. Use when the user asks for LaTeX or a `.tex` file, when working in an existing LaTeX project, or when LaTeX is selected for PDF authoring.
---

# LaTeX Authoring

The goal is to produce maintainable LaTeX that meets the user's requirements, respects an existing project's conventions, and accurately reports what was built and verified.

## Author the LaTeX

Preserve an existing project's document class, engine, bibliography system, structure, and naming unless the user asks to change them.

Follow the project's existing engine declarations, magic comments, and preamble choices. Do not assume that a particular engine or package is available. If the document requires one that the available build path cannot support, report that requirement instead of silently changing the document's format or design. In a multi-file project, add a `% !TEX root` comment to a subordinate file only when Scient needs it to identify the compiled root, and make its path relative to that file.

Before reporting the source ready, make sure the document's commands, environments, and required characters are supported by its preamble and selected engine.

Preserve an existing project's hyperlink configuration. When the document uses a table of contents, citations, cross-references, or URLs, verify the intended navigation after compilation.

Keep `.tex` source files and required assets in the project. A clickable project-relative `.tex` link opens Scient's LaTeX Source, Split, and PDF surface and starts local compilation; a successful build displays the PDF.

## Build and Verify the PDF

This skill grants no tools or authority.

When the user asks for a PDF and `scient_latex_build` is available, call it with the project-relative `.tex` source path and intended project-relative `.pdf` output path. If it returns `in-progress`, wait at least `retryAfterMs` and call it again with the same paths; do not start a parallel build. Use the completed result's paths, page count, diagnostics, and warnings as the build evidence.

If direct build access is unavailable, provide a clickable project-relative Markdown link to the `.tex` source and state that PDF compilation was not verified. The user can open the source in Scient to use its built-in compiler. Creating or opening the source is not evidence that compilation succeeded.

A completed build proves that a structurally valid PDF was produced and published; it does not prove visual quality. When visual review is available, inspect rendered pages of the resulting PDF. Prefer direct page rendering or a PDF preview tool over computer use when it provides the needed view. Review the parts that matter for the document, such as equations, citations and references, pagination, figures, tables, and required characters. Fix material defects, rebuild when appropriate, and verify the updated PDF. If visual inspection is unavailable, say so.

When reporting completion in Scient chat, provide clickable project-relative Markdown links to the exact `sourcePath` and `outputPath` returned by the completed build. If `rootSourcePath` differs, also link it and identify it as the compiled root. Wrap destinations containing spaces in angle brackets. Report the actual `pageCount`, material diagnostics or warnings, and anything that remains unverified. Automatic opening in Scient does not replace these links.
