# Extract PDF content

Read when the user needs page-attributed text, a CSV table or image assets.

- **Text.** Iterate through `pypdf.PdfReader(path).pages` and call `page.extract_text()` per page. Compare columns, captions, footnotes and apparent line-break hyphens with the render before quoting. If the page has no usable text layer, render and transcribe or OCR it, preserve page numbers and mark any uncertain readings. An extraction error alone gives insufficient evidence to call a page scanned.
- **Tables.** Use `pdfplumber` with `page.extract_tables()`. For borderless or horizontal-rule-only tables, try text alignment strategies or crop around each captioned table. Make a page and caption inventory first and reconcile every requested table with it so figure panels and missed tables are caught. Map multiline cells, merged headings and footnotes before exporting rows with `csv.writer` or `DataFrame.to_csv(index=False)`. Keep source strings until you have verified numbers, signs and separators. Check the rendered table for missing rows, split cells or displaced values. Give the page, row count and column count.
- **Images.** Use `pdfimages -list file.pdf` to identify embedded images, then `pdfimages -png file.pdf work/image` to extract them. A vector figure or a composite with text and multiple image fragments may need a rendered crop. Give the page and render DPI for any crop.

Done when every extract has a source page and any uncertain text or unresolved table geometry is identified.

## OCR part of a scan

For only page 2, keep the 300 dpi page image and the raw OCR output. Run these commands in a fresh working directory.

```sh
pdftoppm -f 2 -l 2 -r 300 -png -singlefile scan.pdf page-2
tesseract page-2.png page-2-raw
```

Write `page-2-checked.txt` with the verified region and page, for example “p. 2, printed header”. Compare the words, punctuation and digits against the image. Mark uncertain readings and report diagram or handwriting regions outside the transcription. Keep `page-2-raw.txt` alongside it for comparison.
