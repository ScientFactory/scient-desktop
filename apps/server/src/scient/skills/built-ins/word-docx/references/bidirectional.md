# Hebrew and mixed-direction Word documents

- Write Hebrew and English in logical Unicode order. In a Hebrew paragraph
  use right-to-left paragraph direction (`w:pPr/w:bidi`). Alignment alone
  leaves punctuation, list markers and embedded text under the wrong base
  direction. Use explicit left-to-right runs for English phrases, identifiers,
  formulas and dates that need it. Set `w:rtl` on Hebrew runs where needed for
  complex-script formatting. Keep run direction separate from alignment.
- Choose an installed font with Hebrew and Latin glyph coverage. Set
  `w:rFonts/@w:cs` for the Hebrew font and Hebrew language on
  `w:lang/@w:bidi` where needed. Check size and weight on the complex-script
  run too. For a reused document, preserve its direction and run properties.
- Use a native table. For a right-to-left table, set `w:tblPr/w:bidiVisual`
  and keep cells in logical order. Set direction on cell paragraphs as
  appropriate. Give a numeric-only cell a left-to-right paragraph when its
  value has operators, for example `0.85 ± 0.04`. Right alignment can still
  match the table column. Check where the first logical column appears.
- Render the actual output and inspect Hebrew letters, punctuation next to
  English, digits and decimal marks, list numbering, and table column order.
  Read the file structure and text too. PDF text extraction follows its
  reader's ordering rules. Use the page image to check visible direction.
  Report the renderer used and any Word-specific behavior still unchecked.
