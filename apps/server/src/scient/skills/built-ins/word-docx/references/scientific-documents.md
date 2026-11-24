# Scientific Word documents

Read when a Word manuscript has equations, citation fields, numbered captions, a journal template, or coauthor revisions.

## Equations

Use native Office Math Markup Language (OMML) for editable equations. This verified python-docx and lxml example puts a fraction in a paragraph. Use Unicode math symbols or structured OMML elements for additional notation.

```python
from docx import Document
from lxml import etree

doc = Document()
paragraph = doc.add_paragraph()
paragraph._p.append(etree.fromstring(b"""
<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <m:r><m:t>x=</m:t></m:r>
  <m:f>
    <m:num><m:r><m:t>1</m:t></m:r></m:num>
    <m:den><m:r><m:t>2</m:t></m:r></m:den>
  </m:f>
</m:oMath>
"""))
doc.save("equation.docx")
```

Run the zoom repair and delivery gates in [SKILL.md](../SKILL.md). The lab's current `doc.py render` profile displays OMML. Open the page image and check the glyphs, fraction or other mathematical structure against the source. If the render is unavailable or a particular equation is missing, inspect the saved `m:oMath` or `m:oMathPara` tree and its `m:t` text. For this example, check the `m:f` children `m:num` and `m:den` for 1 and 2. Record whether you verified the rendered appearance.

When editing nearby prose, change the verified Word `w:t` nodes. Compare equation counts and check that the equation trees and rendered notation survive. For a LaTeX source, `"$PY" "$DOC" convert manuscript.tex manuscript.docx` uses Pandoc, which writes supported LaTeX math as OMML. Check the resulting equation trees and rendered notation, especially custom macros, alignment, and numbering. Raw LaTeX text is unsuitable as equation content. If native math is optional and conversion fails for a specific equation, use a legible image with descriptive alt text and disclose that it is an image.

## Citations and bibliography

Preserve Zotero, Mendeley, and EndNote fields, including their `ADDIN` instructions, cached display runs, and related bookmarks or package data. Word fields may be simple (`w:fldSimple`) or spread across runs from `begin` through `separate` to `end`. Look for both forms. If you do not recognize a field, keep the whole field, including nested fields, byte-for-byte wherever possible. Never flatten an unknown field to its displayed text.

Use normal Word runs for prose around citations. Send changes to managed citations or reference lists through the relevant reference manager when available, or document the requested change for the coauthor who owns that library. Compare field instructions, matching bookmark pairs, and referenced parts against the original before delivery. Verify cached display runs as well as the field inventory.

## Captions and cross-references

Use the template's caption style and `SEQ Figure` or `SEQ Table` fields for numbering. Add a uniquely named bookmark around the label or number to be referenced, then point a `REF bookmark_name` field at it. Preserve existing sequence names, switches, and bookmark ranges. When including a cached result, put it after a `w:fldChar` with `w:fldCharType="separate"` and before the end marker. Verify that the field updates in a compatible editor after moving or adding captions. Check the rendered figure or table, its label, and the callout in the text together.

## Journal templates

Create a document instance from the journal's `.dotx`, or copy its supplied `.docx`. Keep its styles, page geometry, sections, numbering, and front-matter fields. Fill named styles and designated placeholders. Compare against the template before changing a caption convention, anonymization setting, or page limit.

## Working with coauthors

Use the agreed review author and make each tracked replacement as small as the meaning permits. Keep existing authors' revisions and comments intact. Anchor questions about interpretation, missing evidence, or ambiguous author intent to the relevant words. Leave revisions pending for coauthors unless they ask for acceptance. Preserve the redlined file when making a clean derivative.

Use Scient's `references` skill to check citation support, `check-reported-numbers` to reconcile manuscript numbers with project outputs, `reviewer-response` for the point-by-point response, and `document-review` for a structured manuscript review. Apply the Word workflow when recording those decisions as edits or comments.
