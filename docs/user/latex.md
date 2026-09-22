# LaTeX

Use the LaTeX workspace to write a paper, report, thesis, or other scientific
document while seeing the compiled PDF beside its source. Opening a `.tex` file
shows Source, Split, Visual, and PDF views. Switch
between them, and drag the divider in split view to resize either side.

## Write visually, verify with TeX

Visual is a source-derived writing canvas, not an editable PDF. You can start
writing before installing or running TeX. Its toolbar supports paragraphs,
three heading levels, bold, italic, lists, undo/redo and inserting equations.
Math normally stays rendered in the document. Click a formula to open an
anchored editor showing its complete LaTeX, including `$`, `$$`, `\(`, `\[`, or
the surrounding equation environment. Apply commits the source as one editor
transaction; Escape cancels it. The same popover enables structured math input
and its math keyboard.

The Insert menu creates display equations, bracket or parenthesis matrices,
cases, and aligned equations. You can also type a complete `matrix`, `bmatrix`,
`pmatrix`, `vmatrix`, `Vmatrix`, `cases`, or `aligned` environment on an otherwise
empty visual paragraph; Scient converts it only after the matching `\end{...}`
is complete. Unsupported or malformed environments remain ordinary text or
protected source rather than being partially rewritten.
Source remains the authoritative `.tex` file. Source and Visual share the same
revision-checked save queue; switching views does not create a second document.

Writing view uses browser layout with locally bundled math fonts. It is always
approximate: page breaks, floats, numbering, references, package output and
arbitrary macro expansion require TeX. Rebuild, then select PDF or Split to
inspect exact output. A successful build never means the browser canvas is
pixel-identical to that PDF. Compile errors preserve the last successful PDF.

Unsupported structures, including tables, custom macros and equation labels or
tags, appear as protected source blocks. Edit LaTeX opens the source editor for
these; the visual editor does not silently normalize or discard them. A visual
edit cannot delete across a protected block. Open an included file to edit its
contents; the established root still controls the PDF build.

Common citation and reference commands, including author/year and page
references, are editable as keys, not resolved bibliography output. Preamble,
macro and global-layout edits show a rebuild
notice. After a crash or interrupted save, a recovered draft is offered as
copyable source, never automatically written over a newer file.

## Math insertion

The source editor's **Ω** toolbar provides shared math symbols, fractions, roots,
and matrices. Its shortcuts and completion behavior are configured in
**Settings → Shortcuts → Math**, alongside Markdown math.
See [math authoring](./math-in-chat.md#authoring-math) for defaults and source-safety
limitations. These controls change LaTeX source; PDF read mode does not insert math.

## Build and review

Builds are explicit: choose Rebuild after pending source saves finish. Opening,
typing, autosaving, status polling and toolchain installation do not compile.
An agent can still explicitly request a build through the existing tools. Errors and
warnings from the build appear in a list above the document; each one shows
the file and line it came from when the compiler reported one. Click a message
that names a project file to open that file at the reported line.

You can also ask an agent to create or edit a project LaTeX document and build
it as a PDF. When the connected provider supports Scient's document tools, the
agent uses the same qualified LaTeX toolchain, saves the requested PDF inside
the project, and opens the compiled document in Split view. A successful build
proves that the PDF compiled; ask the agent to inspect the rendered pages when
visual quality matters.

## Move between source and PDF

In Split, double-click a line of source to jump to the matching place in the
current successful PDF. Double-clicking a word in the PDF keeps the normal word
selection and reveals the corresponding source line in the source pane. These
gestures never open Split automatically; select Split first when you want both
sides to follow one another. Scient briefly marks the destination so it is easy
to see. This needs a successful current build with a navigation index. If no
mapping is available, the PDF remains usable and the status explains why the
jump could not be completed.
The exactness comes from the compiler's navigation index: some complex or RTL
lines contain only a line-level location, so those lines can land near the
typeset line instead of on the exact word.

The PDF keeps your place across rebuilds: your page, zoom, and scroll position
stay put while a new version comes in, instead of snapping back to the top. If
the PDF you're looking at is older than the source it was built from, a stale
badge tells you so.

## Choose a LaTeX engine

Scient compiles with pdfLaTeX, driven through `latexmk` — or through Tectonic
instead, if that's what it finds. On the `latexmk` path, XeLaTeX and LuaLaTeX
aren't run: if a document asks for one, through a `% !TEX program = xelatex`
(or `lualatex`) comment or by loading a package pdfLaTeX can't process, such as
`fontspec` or `unicode-math`, Scient detects that before the build starts and
the error explains what the document needs instead of failing partway through a
compile that was never going to work. Tectonic's engine is XeTeX-based, so with
Tectonic installed those same documents build normally and nothing is refused.

Engine-aware documents that load packages only in the appropriate conditional
branch are allowed to build normally.

## Install a LaTeX distribution

If Scient can't find a LaTeX installation on your computer, it offers to
install TinyTeX for you — a small distribution, about 70 MB, that lives with
Scient and needs no administrator access. That install includes the packages
most documents need, and anything still missing installs automatically the
first time a document uses it; with your own TeX distribution, the error names
the package to install. The first build of a document can therefore take a few
minutes while those packages arrive — Scient says so, and names them, while it
waits. Later builds of the same document are as fast as any other compile.
Installing a package needs a network connection: when
you're offline, or when no package by that name can be found, the build stops
and the error says which one it was. This one-click install is available on
Windows (x64), macOS (Intel and Apple Silicon), and Linux (x64). On other
architectures, install TeX Live, MiKTeX, or Tectonic yourself, and Scient will
use it — an existing installation always keeps precedence over Scient's own,
on every platform. If you install one while a document is already open, select
Rebuild: asking for a build by hand also makes Scient look for an engine
again, so the one you just installed is picked up without reopening the file
or restarting.

Compiling never leaves clutter in your files: build output, logs, and other
compiler byproducts stay out of your project entirely.

## Choose the root document

For a project with multiple `.tex` files, add a comment near the top of a file
that isn't the main document:

```
% !TEX root = main.tex
```

Scient then compiles from `main.tex` when you request Rebuild, following the
same convention other LaTeX editors use.
