# LaTeX

Opening a `.tex` file in Scient opens it as a live LaTeX document instead of
plain source: a source view, a split view with the compiled PDF alongside your
editing, and a PDF-only view. Switch between them, and drag the divider in
split view to resize either side.

Builds happen automatically — save the file and Scient compiles it. Errors and
warnings from the build appear in a list above the document; each one shows
the file and line it came from when the compiler reported one. Click a message
that names a project file to open that file at the reported line.

Hold Ctrl (Command on a Mac) and double-click a line of source to jump to the
matching place in the current successful PDF; the same gesture on the PDF opens
the corresponding source line. Scient briefly marks a source-to-PDF destination
so the matching place is easy to see. This needs a successful current build. If the
PDF has no navigation index, it still opens and reads normally. Scient ships
the small source-navigation helper itself, so this works the same way with
TinyTeX, TeX Live, MiKTeX, or Tectonic and requires no extra package or PATH
setup. If navigation cannot run, the status names the actual condition — for
example a missing index, no mapping at that position, a timed-out query, or a
damaged application helper — while leaving the PDF usable.
The exactness comes from the compiler's navigation index: some complex or RTL
lines contain only a line-level location, so those lines can land near the
typeset line instead of on the exact word.

The PDF keeps your place across rebuilds: your page, zoom, and scroll position
stay put while a new version comes in, instead of snapping back to the top. If
the PDF you're looking at is older than the source it was built from, a stale
badge tells you so.

Scient compiles with pdfLaTeX, driven through `latexmk` — or through Tectonic
instead, if that's what it finds. On the `latexmk` path, XeLaTeX and LuaLaTeX
aren't run: if a document asks for one, through a `% !TEX program = xelatex`
(or `lualatex`) comment or by loading a package pdfLaTeX can't process, such as
`fontspec` or `unicode-math`, Scient detects that before the build starts and
the error explains what the document needs instead of failing partway through a
compile that was never going to work. Tectonic's engine is XeTeX-based, so with
Tectonic installed those same documents build normally and nothing is refused.

A document that loads `fontspec` only inside an engine test — the
`\usepackage{iftex}` and `\ifPDFTeX … \else … \fi` pattern Pandoc's default
template writes — isn't refused either. That document compiles fine under
pdfLaTeX, because the branch loading those packages is never taken, so Scient
lets the build run and answer for itself.

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

For a project with multiple `.tex` files, add a comment near the top of a file
that isn't the main document:

```
% !TEX root = main.tex
```

Scient then compiles from `main.tex` whenever you edit or save that file, the
same convention other LaTeX editors use.
