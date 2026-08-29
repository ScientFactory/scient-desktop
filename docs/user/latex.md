# LaTeX

Use the LaTeX workspace to write a paper, report, thesis, or other scientific
document while seeing the compiled PDF beside its source. Opening a `.tex` file
shows a source view, a split source-and-PDF view, and a PDF-only view. Switch
between them, and drag the divider in split view to resize either side.

## Build and review

Builds happen automatically — save the file and Scient compiles it. Errors and
warnings from the build appear in a list above the document; each one shows
the file and line it came from when the compiler reported one. Click a message
that names a project file to open that file at the reported line.

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

Scient then compiles from `main.tex` whenever you edit or save that file, the
same convention other LaTeX editors use.
