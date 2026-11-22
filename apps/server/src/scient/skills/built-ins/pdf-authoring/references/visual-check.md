# Render and inspect the PDF

Look at the final saved PDF, not a stale build or an HTML screenshot. Put page images in a new temporary folder outside the project.

If `pdftoppm` (Poppler) is installed: `pdftoppm -r 150 -png final.pdf <new-folder>/page`.

Otherwise use PyMuPDF, from an existing environment that has it or a disposable one; Scient's default Python has only `pypdf`, which cannot render pages. Install into the disposable environment, never into the user's or Scient's own Python:

```sh
# macOS or Linux
python3 -m venv "${TMPDIR:-/tmp}/pdf-review-env"
"${TMPDIR:-/tmp}/pdf-review-env/bin/python" -m pip install pymupdf
"${TMPDIR:-/tmp}/pdf-review-env/bin/python" render_pdf.py final.pdf <new-folder> --pages 1,2,5
```

```powershell
# Windows
py -3 -m venv "$env:TEMP\pdf-review-env"
& "$env:TEMP\pdf-review-env\Scripts\python.exe" -m pip install pymupdf
& "$env:TEMP\pdf-review-env\Scripts\python.exe" render_pdf.py final.pdf <new-folder> --pages 1,2,5
```

`render_pdf.py` is this skill's `scripts/render_pdf.py` (read it with `scient_skill_read_resource` and save it in the temporary folder). Omit `--pages` for every page; the output folder must not exist yet, so use a new one after each rebuild. It prints the page count and the image paths.

Open the images with your image-view tool and actually look at them. If you can't render or view them, say that visual inspection was not performed and why. Page images don't show live links, font embedding or tags; check those in the PDF structure when they are required.
