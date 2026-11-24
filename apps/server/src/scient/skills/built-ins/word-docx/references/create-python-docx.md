# Creating documents with python-docx

Read when: building a new `.docx` (or adding whole structures – tables, lists, TOC, headers) with the document runtime’s Python. For surgery on an existing file read `edit-ooxml.md` instead.

Run scripts with the runtime interpreter (`PY` from `SKILL.md`); `import docx` must resolve there (`doc.py probe` → `python_modules.docx`). Write the generator as a real script file the user can re-run, not a one-off REPL paste, whenever the document has more than a page of structure.

## Styles discipline

- Format through named paragraph/character styles. Configure `Normal` (base font, size, line spacing, space-after) once on `doc.styles["Normal"]`, then let content inherit.
- Headings use the built-in ladder `Title` → `Heading 1` → `Heading 2` → `Heading 3`, in order, never skipping a level for looks. Restyle those built-ins (font, size, color, spacing, keep-with-next) rather than inventing look-alike styles: navigation pane, TOC fields, and accessibility tools all key on the built-in names/outline levels.
- A heading made by bolding a `Normal` run and bumping its size is a defect even if it renders beautifully – it is invisible to outline, TOC, and screen readers. The same applies to fake captions, fake quotes, fake list items: if Word has a structure for it, use the structure.
- Direct formatting (`run.bold`, `run.font.size`, paragraph alignment) is for genuine local exceptions – one emphasized term, one centered line – not as a styling system. If you set the same direct format three times, make or adjust a style.
- Keep a short palette: define the fonts and sizes for `Normal`, the heading ladder, `Caption`, `Quote`/`Intense Quote` if used, and table text, before writing content. Match the user's/template's fonts when one is given; otherwise choose widely available fonts so LibreOffice rendering in the QA gate is trustworthy.

Done when: every heading in the saved file reports a `Heading N`/`Title` style under `doc.py inspect`, and no paragraph fakes a heading with direct formatting.

## Sections, page setup, headers and footers

- Page size and margins live on sections (`doc.sections[0].page_width/page_height`, margins in `Mm`/`Inches`). Set them explicitly as described in step 3 of [SKILL.md](../SKILL.md). Use a new section to change orientation or column layout. New sections inherit linked headers and footers until you unlink them.
- Headers/footers: `section.header` / `section.footer`, with `section.different_first_page_header_footer` for a distinct cover page, and `header.is_linked_to_previous = False` before editing a later section's header independently (editing a linked header silently edits them all).
- Use a field for page numbers. Insert `w:fldChar begin`, `w:instrText` with `PAGE` (or `NUMPAGES` for the total), and `w:fldChar end`, each in its own run. When supplying a cached result, insert `w:fldChar separate` after the instruction and before the result run. Restart/continue numbering per section via `w:pgNumType` when front matter needs roman numerals or a fresh start. Type the surrounding text ("Page ", " of ") as ordinary runs around the fields.

Done when the rendered page numbers are correct and the XML contains the page-number field instructions.

## Tables

- Create with `doc.add_table(rows, cols, style=...)` using a real table style (`Table Grid` or a template style), then set column widths deliberately. Set width on every cell in the column (and the table's grid) – setting `table.columns[i].width` alone is unreliable because Word/LibreOffice weight cell widths. Widths must sum to the section's text width; do the arithmetic in the script from `section.page_width - margins`, do not eyeball.
- Turn off autofit once widths are chosen (`table.autofit = False`) so the renderer respects them.
- Repeat the header row on every page: set `w:tblHeader` on the first row's `trPr` (OOXML snippet – python-docx exposes no property). Long tables without a repeating header are unreadable after the first page break.
- Never set fixed row heights (`w:trHeight` exact / `row.height` with exact rule) on rows containing wrapped text: content taller than the row is clipped invisibly. Leave height automatic; use cell margins and font size to control density.
- Style cell text with paragraph styles inside cells (header row bold via a style or run property on that row), align numbers consistently, and keep header text short. Merged cells via `cell.merge(...)` before adding content, then write into the top-left cell only.
- A table used purely to lay out a page (columns of prose, sidebars) will fail reflow and accessibility; use sections/columns or plain paragraphs instead.

Done when: the rendered table fits the text width, its header repeats after a page break, and no cell text is clipped at any row.

## Lists

- Bullets and numbering come from list styles (`List Bullet`, `List Number`, and their level variants) backed by `word/numbering.xml` – never type "•", "-", or "1." at the start of a paragraph. Typed markers do not renumber, indent wrongly, and break when items are reordered.
- Multi-level lists need the level variants or explicit `w:ilvl` on the paragraph; continuous vs restarted numbering needs distinct numbering instances – when python-docx's built-in styles will not express the scheme (legal-style multi-level, per-chapter restart), drop to OOXML on `numbering.xml` per `edit-ooxml.md` rather than faking it with typed numbers.

For native numbered headings in a new document, use `Heading 1` and bind each heading to the same numbering instance with `numPr`. This example takes the decimal format from the default template and creates a separate heading sequence.

```python
from docx import Document

doc = Document()
numbering = doc.part.numbering_part.element
list_id = doc.styles["List Number"].element.pPr.numPr.numId.val
abstract_id = numbering.num_having_numId(list_id).abstractNumId.val
heading_num = numbering.add_num(abstract_id)

for title in ("Methods", "Results"):
    heading = doc.add_paragraph(title, style="Heading 1")
    num_pr = heading._p.get_or_add_pPr().get_or_add_numPr()
    num_pr.get_or_add_ilvl().val = 0
    num_pr.get_or_add_numId().val = heading_num.numId

doc.save("headings.docx")
```

For a supplied template, use its heading numbering definition. Check that the saved headings have the intended outline level and render with the expected sequence.

Done when: deleting the middle item in Word would renumber the rest automatically.

## Images

- Insert with an explicit size: `doc.add_picture(path, width=Mm(...))` (width alone preserves aspect ratio). Never insert at native pixel size sight-unseen; office files balloon and layouts explode. Cap width at the text width.
- Prefer PNG for line art/screenshots, JPEG for photographs. Set the image's alt text/description where the format allows via the drawing element when the document is for distribution.
- Captions go in a following `Caption`-styled paragraph (see Cross-references in `scientific-documents.md` for numbered captions).

Done when: every image renders at its intended size with undistorted proportions.

## Fields: TOC, captions, cross-references

- Table of contents: insert a TOC field (`TOC \o "1-3" \h \z \u`) as field XML in a paragraph where the TOC belongs. python-docx cannot populate it: add a cached result between `separate` and `end` if needed, then update the TOC in a compatible editor to populate it. Tell the user to update fields on open (Word: F9 / right-click → Update Field), or ship after a LibreOffice pass that materializes it – and say which you did. Choose the switches to match the heading scheme. `\o` collects headings through built-in heading styles, `\u` uses paragraph outline levels, and `\t "My Heading,1,My Subheading,2"` maps named custom styles to TOC levels.
- Caption numbers and cross-references use `SEQ`/`REF` fields (see `scientific-documents.md`). The same materialization caveat applies: renderers may show cached field results, so write the expected display text between `separate` and `end` and check what rendered.

Done when: fields exist as fields (visible in the XML as `w:instrText`), with cached display text, and the user has been told how they refresh.

## Known limits of python-docx – when to drop to OOXML

python-docx deliberately covers a subset. Expect to inject XML (`paragraph._p`, `run._r`, `table._tbl`, or full part edits per `edit-ooxml.md`) for:

- Footnotes and endnotes have no authoring API. Needs `word/footnotes.xml`, its relationships, content-type entry, and `w:footnoteReference` runs – a surgery job. Do not fake footnotes with superscript digits plus a paragraph at page bottom; pagination will strand them.
- Tracked changes require XML edits. python-docx 1.2 can add simple comments, but use the lab OOXML workflow for this skill so you can control anchors and preserve existing review parts.
- Fields of every kind (PAGE, TOC, SEQ, REF, DATE): raw field XML as above.
- Equations (OMML), text boxes, SmartArt, charts as native parts, headers' floating images with wrap: XML/part work.
- Hyperlinks: no one-liner; add the relationship then a `w:hyperlink` element (well-known snippet) – still python-docx-level, just verbose.
- Anything it does read, it reserializes on save: parts it does not understand generally survive, but styles/numbering/settings it touches get rewritten. For existing files, use the targeted edit and preservation gates in [edit-ooxml.md](edit-ooxml.md).

Rule of thumb: generating fresh structure → python-docx first, XML snippets for the gaps. Preserving an existing package → surgery first (see `edit-ooxml.md`).

## Word templates

Open a `.dotx` in Word as a new document and save that instance as `.docx`. For a headless start, try `"$PY" "$DOC" convert TEMPLATE.dotx working.docx` and check the resulting sections, styles, fields, and layout against the template. This route re-exports the package through LibreOffice. Use a Word-created instance or a supplied `.docx` when fidelity requires it. Changing the filename extension alone leaves the internal template type intact, which the runtime's python-docx-based inspector rejects. If editing the template itself was requested, take the targeted OOXML path and retain the template content type and `.dotx` extension.

## Repair a missing zoom percentage

The lab's python-docx default template carries a `w:zoom` element with no `w:percent`. After saving, run the repair before validation.

```bash
"$PY" "$TOOLS/ooxml/docx_fix_zoom.py" OUT.docx
"$PY" "$DOC" validate OUT.docx
```

Use `-o REPAIRED.docx` to write a separate copy. The helper fills a missing percentage on an existing zoom element with `100` in Transitional OOXML or `100%` in Strict OOXML. It checks ZIP member and expanded-size limits before rewriting. It preserves the order and uncompressed bytes of all other ZIP entries.

Done when the repaired file passes validation and its rendered pages have been inspected.
