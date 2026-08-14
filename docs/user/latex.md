# LaTeX

Opening a `.tex` file in Scient opens it as a live LaTeX document instead of
plain source: a source view, a split view with the compiled PDF alongside your
editing, and a PDF-only view. Switch between them, and drag the divider in
split view to resize either side.

Builds happen automatically — save the file and Scient compiles it. Errors and
warnings from the build appear in a list above the document; each one shows
the file and line it came from when the compiler reported one.

The PDF keeps your place across rebuilds: your page, zoom, and scroll position
stay put while a new version comes in, instead of snapping back to the top. If
the PDF you're looking at is older than the source it was built from, a stale
badge tells you so.

If Scient can't find a LaTeX installation on your computer, it offers to
install TinyTeX for you — a small distribution, about 70 MB, that lives with
Scient and needs no administrator access. That install includes the packages
most documents need, and anything still missing installs automatically the
first time a document uses it; with your own TeX distribution, the error names
the package to install. You can also install TeX Live,
MiKTeX, or Tectonic yourself, and Scient will use it instead; an existing
installation always keeps precedence over Scient's own. If you install one
while a document is already open, select Rebuild: asking for a build by hand
also makes Scient look for an engine again, so the one you just installed is
picked up without reopening the file or restarting.

Compiling never leaves clutter in your files: build output, logs, and other
compiler byproducts stay out of your project entirely.

For a project with multiple `.tex` files, add a comment near the top of a file
that isn't the main document:

```
% !TEX root = main.tex
```

Scient then compiles from `main.tex` whenever you edit or save that file, the
same convention other LaTeX editors use.
