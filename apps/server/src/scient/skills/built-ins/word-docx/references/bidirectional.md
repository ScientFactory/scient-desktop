# Hebrew and mixed-direction Word documents

- Write Hebrew and English in logical Unicode order. In a Hebrew paragraph
  use right-to-left paragraph direction (`w:pPr/w:bidi`). Alignment alone
  leaves punctuation, list markers and embedded text under the wrong base
  direction. Use explicit left-to-right runs for English phrases, identifiers,
  formulas and dates that need it. Set `w:rtl` on Hebrew runs where needed for
  complex-script formatting. Let an RTL paragraph inherit its normal reading-
  edge alignment unless the document calls for another layout. If an edit
  should fix a Hebrew paragraph that sits on the wrong edge, use logical
  start alignment (`w:jc w:val="start"`) with `w:bidi` and check the rendered
  edge. A hard-coded physical right setting can land on the left edge in
  Microsoft Word and LibreOffice.
- Choose an installed font with Hebrew and Latin glyph coverage. Set
  `w:rFonts/@w:cs` for the Hebrew font and Hebrew language on
  `w:lang/@w:bidi` where needed. Check size and weight on the complex-script
  run too. For a reused document, preserve its direction and run properties.
- Use a native table. For a right-to-left table, set `w:tblPr/w:bidiVisual`
  and keep cells in logical order. Set direction on cell paragraphs as
  appropriate. Give a numeric-only cell a left-to-right paragraph when its
  value has operators, for example `0.85 ± 0.04`. Right alignment can still
  match the table column. Check where the first logical column appears.
- Check the rendered paragraph edge and reading order separately. Check
  whether ordinary Hebrew prose starts at the right edge in the baseline
  image, including when its XML already says RTL. Report paragraphs on the
  wrong edge as an inherited defect when the task preserves the layout. Check
  Hebrew before and after an inline English span, and English before and
  after an inline Hebrew span. Include a wrap across lines when one occurs.
  Check niqqud, quotes, brackets, dates, IDs, percentages and the sign on
  both ends of a range. Keep the text in logical order. If an opposite-
  direction span reorders, add a directional boundary for that span and
  recheck the image. Invisible direction marks can survive copying. Compare
  exact IDs and values with the source, and check the saved comment anchor
  text when the span carries a comment.
- Give new Hebrew comments their own paragraph and run direction. Check
  the exact comment anchor in the saved DOCX and the balloon in Word or a
  marked-up export when its appearance matters.
- Reopen and inspect the actual PDF export when delivering one. Compare
  affected areas against the source in Word when available, including
  table order, repeated headers, page boundaries and mixed-direction
  spans. A range can read correctly in Word and reverse in a PDF export.
  Record the renderers, pages inspected and any unverified view.
