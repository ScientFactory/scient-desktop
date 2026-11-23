# Google Workspace visual checks and export

Read for requested exports and changes whose correctness depends on appearance.
Check native Sheets values, formulas, formats and dimensions with structured
reads. An image or PDF answers questions about the layout of that view.

- Use slide thumbnails or export the requested native file via `export_file`
  with the intended MIME type. A PDF export can show print layout, missing
  content, wrapping and page order. Check the affected pages or slides.
- A returned file reference must be materialized by the host or saved through
  its authenticated file UI before a local shell tool can open it. A file URI
  by itself may be opaque. If only a reference is available, report which
  check requires the actual bytes.
- Drive export limits output to 10 MB. If the connector supports it, use
  `fetch` with `download_raw_file=true`, `raw_export_mime_type="application/pdf"`
  and `include_base64=false` to request a streamed file reference.
- Render a local PDF with `pdftoppm` or the staged `doc.py render` helper.
  `scient_document_runtime` gives the Python executable and tools directory
  when local helpers are available. Report which views you could inspect.
