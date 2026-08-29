---
name: latex-authoring
description: Create or modify LaTeX documents in Scient. Use when the user requests LaTeX or a .tex source, when working in an existing LaTeX project, or when PDF authoring selects LaTeX as the appropriate source format.
---

# LaTeX Authoring

The goal is to produce maintainable LaTeX source that fits the user's purpose, respects the project's authoring conventions, and has a truthfully reported build state.

Honor the user's requested format and preserve an existing project's document class, engine requirements, bibliography system, structure, and naming unless the user asks to change them. Keep the source semantic and use packages, custom layout, or multiple files only when they materially help the document.

Do not assume a particular engine or package is available. Follow existing magic comments and preamble choices. For a new document with no engine requirement, prefer broadly supported LaTeX; when the content genuinely requires engine-specific features, state that requirement rather than silently changing formats. Keep assets workspace-relative. In a multi-file document, use `% !TEX root = main.tex` in subordinate files only when needed.

Before reporting source ready, reconcile the document body with its preamble: every command, environment, and required glyph must be supported by the selected engine and packages. Validate custom commands in every context where they expand.

Configure PDF hyperlinks deliberately. Preserve an existing project's link style. For a new document, choose unobtrusive, accessible styling and avoid accidental default boxed annotations. After compilation, verify the intended contents entries, citations, cross-references, and URLs.

In Scient, a workspace `.tex` file is a first-class editable source. Create it in the project. Opening a project-relative link opens Scient's LaTeX Source, Split, and PDF surface, starts local compilation, and shows the PDF after a successful build.

When the requested deliverable includes a PDF and `scient_latex_build` is available, call it with the project-relative `.tex` source path and intended project-relative `.pdf` output path. The tool follows `% !TEX root`, joins an existing build for the same resolved root, and returns either `completed` or `in-progress`. For `in-progress`, wait at least the returned `retryAfterMs`, then call the same tool again with the same paths; do not poll rapidly or launch parallel builds. On completion, treat the returned evidence as authoritative. When reporting completion to the user in Scient chat, provide clickable project-relative Markdown links to the exact returned `sourcePath` and `outputPath`; if `rootSourcePath` differs, also link it and identify it as the compiled root. Wrap link destinations containing spaces in angle brackets. Report the returned `pageCount` and meaningful diagnostics rather than intended values. Automatic opening in Scient does not replace these links.

If direct build access is unavailable, provide a clickable project-relative Markdown link to the `.tex` source and state that compilation was not verified; the user can open that link to use Scient's built-in compiler. Opening a link or creating a source is not evidence that compilation succeeded.

When build evidence is available, fix fatal compiler errors first. After a successful normal multipass build, reassess secondary reference and navigation warnings that may have resulted from the interrupted build.

A completed build proves structural compilation and publication, not visual quality. Inspect meaningful diagnostics and the rendered PDF when those views are available rather than treating a successful compiler exit as proof of quality. Check the parts that matter for the document, such as equations, citations and references, pagination, figures, tables, and required glyphs. Fix material defects when possible. Link an actual project PDF only when one was produced, and report any unverified build or output property clearly.

This skill provides guidance only and grants no tools, packages, credentials, or permissions.
