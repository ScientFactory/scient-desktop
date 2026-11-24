# Edit a deck or fill a template

Read when modifying an existing PowerPoint or making a deck from a supplied template. pptxgenjs generates new decks. Use the existing package as the starting point here.

1. **Map the slides.** Run both commands and open the thumbnail grid. Use a unique output prefix, without an extension. The grid labels show part names, which can differ from presentation positions after reordering. For a .potx, first save a working .pptx through a compatible editor or a verified conversion. The thumbnail helper expects .pptx.

   ```sh
   PYTHONPATH="$TOOLS" "$PY" "$TOOLS/ooxml/thumbnail.py" template.pptx work/template-grid --cols 4
   "$PY" "$TOOLS/ooxml/slide_text.py" template.pptx
   ```

   Done when each kept, duplicated or removed slide has a role and a slide part name.

2. **Make structural changes before content changes.** Unpack the working copy into a fresh directory after checking ZIP paths, duplicate entries and expanded size. Use Python `zipfile` with safe member paths. In the unpacked tree, reorder or remove the relevant `p:sldId` entries in `ppt/presentation.xml`. Add or duplicate with the helper so it creates the slide ID, package relationship and content-type entry.

   ```sh
   PYTHONPATH="$TOOLS" "$PY" "$TOOLS/ooxml/add_slide.py" unpacked/ slide2.xml --after slide3.xml
   ```

   The helper creates an empty shape tree from `slideLayoutN.xml`. To start with the layout’s cloneable placeholders, use python-pptx `slides.add_slide(layout)`. To keep populated slide objects, duplicate the slide, then restore speaker notes from the source or supply new notes. The helper drops the notes relationship when duplicating. A duplicated slide can share linked assets such as chart parts. Inspect relationships before changing shared content and add independent parts when the duplicate needs independent data. Done when slide count, order and shared assets are accounted for.

3. **Edit content.** Use targeted OOXML changes for preservation-sensitive decks. For a simple text edit in a compatible deck, use python-pptx on the package and change the relevant `run.text`. Assigning to the whole paragraph or text frame replaces its runs. Inspect the runs if visible words are split across them. python-pptx has no public slide duplication or reorder API. A custom title placeholder can have a nonzero index and be missed by `shapes.title`. Look up its placeholder type as well. When updating a chart through OOXML, keep its relationships and update both the chart cache and its embedded workbook. Done when the requested text and values changed and the template's formatting and other content survived readback.
4. **Clean and check.** After structural or unpacked XML edits, run `PYTHONPATH="$TOOLS" "$PY" "$TOOLS/ooxml/clean.py" unpacked/` before repacking the contents at the ZIP root. Follow the three gates in [SKILL.md](../SKILL.md), including validation with the source .pptx as `--original`. Reopen the repacked deck and verify placeholder types and positions, speaker notes, section membership and link destinations. Compare each rendered slide with its mapped reference. Done when every result matches the intended layout and the report names any fidelity checks that need PowerPoint.

## Worked slide insert, notes edit and removal

Read when the edit changes slide order, slides or notes in a retained deck.

In this example, duplicating `ppt/slides/slide4.xml` inserted `slide135.xml` at position 5. Removing the last slide dropped `slide134.xml`. The retained-slide mapping followed the source part names.

| Source part               | Source position | Result position | Render check                                                                                     |
| ------------------------- | --------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `slide4.xml`              | 4               | 4               | Source comparison for the retained slide                                                         |
| Duplicate of `slide4.xml` | –               | 5               | Check the new checklist and intended shared assets                                               |
| `slide16.xml`             | 16              | 17              | Allow the changed slide-number footer. Record the logo touching the last bullet on both renders. |
| `slide134.xml`            | 134             | Removed         | Check for incoming links and remove orphaned parts                                               |

Follow the office-document relationship in `_rels/.rels` to `ppt/presentation.xml`. Walk `p:sldIdLst` in order and resolve each `r:id` via `ppt/_rels/presentation.xml.rels` to its slide part. For the citation on slide 2, follow the notesSlide relationship from `ppt/slides/_rels/slide2.xml.rels` to its notes part, `ppt/notesSlides/notesSlide2.xml`. Locate the notes body shape via `p:ph[@type="body"]`, and append a new `a:p` with the citation as an `a:r/a:t` inside the shape's `p:txBody`. Keep the earlier paragraphs and their formatting. Reopen and compare the existing body paragraphs before the appended one.

After cleanup, follow reachable internal relationships from the package root and resolve each relative target from its owning part. Compare reachable payloads with ZIP members and check that every content-type override names an existing part. Check slide and notes links in that graph, then compare renders by the source-to-result map. Check whether a footer-only difference follows a position-derived slide number. Report a defect that was present on the matched baseline with both locators.
