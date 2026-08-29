---
name: latex-authoring
description: Create or modify LaTeX documents in Scient. Use when the user requests LaTeX or a .tex source, when working in an existing LaTeX project, or when PDF authoring selects LaTeX as the appropriate source format.
---

# LaTeX Authoring

The goal is to produce maintainable LaTeX source that fits the user's purpose, respects the project's authoring conventions, and has a truthfully reported build state.

Honor the user's requested format and preserve an existing project's document class, engine requirements, bibliography system, structure, and naming unless the user asks to change them. Keep the source semantic and use packages, custom layout, or multiple files only when they materially help the document.

Do not assume a particular engine or package is available. Follow existing magic comments and preamble choices. For a new document with no engine requirement, prefer broadly supported LaTeX; when the content genuinely requires engine-specific features, state that requirement rather than silently changing formats. Keep assets workspace-relative. In a multi-file document, use `% !TEX root = main.tex` in subordinate files only when needed.

Reconcile the body against the preamble before reporting a source ready: every command, environment, and glyph the document uses must have its defining package or engine feature loaded. Undefined control sequences from an unloaded package are the most common failure in generated LaTeX; a typical slip is `\mathscr` without `mathrsfs` or `unicode-math`.

Configure PDF hyperlinks deliberately. For a new document, prefer `\usepackage[hidelinks]{hyperref}` unless visible link styling materially helps; if links should be visible, use restrained accessible text colors instead of default boxed annotations. Preserve an existing project's link style. After compilation, verify that contents entries, citations, cross-references, and URLs are clickable.

In Scient, a workspace `.tex` file is a first-class editable source. Create it in the project and provide a project-relative Markdown link. Opening the link opens Scient's LaTeX source and PDF view, starts local compilation, and shows the PDF after a successful build. If direct build access is unavailable, state that the source is ready to compile; opening a link or creating a source is not evidence that compilation succeeded.

When build evidence is available, inspect meaningful diagnostics and the rendered PDF rather than treating a successful compiler exit as proof of quality. Check the parts that matter for the document, such as equations, citations and references, pagination, figures, tables, and required glyphs. Fix material defects when possible. Link an actual project PDF only when one was produced, and report any unverified build or output property clearly.

This skill provides guidance only and grants no tools, packages, credentials, or permissions.
