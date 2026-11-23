# Editing existing documents: safe edits vs OOXML surgery

Read when: changing a `.docx`/`.dotx` that already exists, adding tracked changes or comments, or doing anything python-docx cannot express. A `.docx` is a zip of XML parts (the OPC package); surgery means editing those parts directly so everything you did not touch survives byte-for-byte.

## Preflight and unpack

Make the trust decision in [SKILL.md](../SKILL.md) before opening an input.
For direct OOXML helpers, preflight the package before reading or extracting members. Check at most 10,000 entries, 512 MiB total expanded, and 128 MiB per entry. Reject symlinks, absolute or escaping paths, normalized duplicate paths, and file/directory collisions. Use a parser with DTDs and external entities disabled for inspected XML. Run the read-only `docx_feature_inventory.py INPUT.docx` to check the ZIP and scan its XML. The comment, zoom and accept-changes helpers also check package bounds before processing. For directory-mode helpers, use only a freshly preflighted extraction in a scratch directory.

Use the runtime's `office.helpers.safe_extract` after preflight when a directory is needed. Keep the original outside scratch and run adopted helpers with `PYTHONPATH="$TOOLS"` so they can import the runtime's `office` package.

Done when the input passes preflight, any scratch extraction has `[Content_Types].xml` at its root, and the original is available as the baseline.

## Choose the edit

Limit plain-text edits to individually verified `w:t` nodes. Inspect the parent run, ancestors and surrounding runs. Check that the target is ordinary prose outside fields (including cached results), revisions, equations and controls. Check bookmarks and comment ranges across the edit so it keeps their intended anchor. Update only the text node and its `xml:space` when needed. Use targeted OOXML for any change to the structure itself, including review objects, fields, numbering, notes and floating content. A true `.dotx` may require direct part inspection if python-docx rejects its template content type. To fill a template as a document, see [Word templates](create-python-docx.md#word-templates).

Avoid these python-docx calls on existing content:

- `paragraph.text = …` and `paragraph.clear()` remove the paragraph's content, including native equations, bookmarks, review markup and hyperlinks.
- `run.text = …` replaces the run's content, including fields, drawings and note references.
- `cell.text = …` removes the cell's existing paragraphs, nested tables and their content.
- Editing a shared style changes every location that uses it. Use a local edit for a change confined to one occurrence.

Done when each target has a recorded story, paragraph and node or range in the original and the edit uses those locations.

## Find text across runs

Search the original story by joining text across adjacent runs for matching while keeping a mapping back to each `w:t` and its offset. Respect boundaries such as fields, paragraph breaks and revisions. Inspect each relevant story, including notes or headers when they contain the target.

When normalization helps find a match, work on a disposable search copy.

```bash
PYTHONPATH="$TOOLS" "$PY" "$TOOLS/ooxml/merge_runs.py" ORIGINAL.docx -o SEARCH_ONLY.docx
```

This helper handles the main story and can remove proofing and revision-session markers or produce invalid XML. Map the location back to the original XML, then write the edit into a copy made from the original package.

Done when the edit is expressed against the original tree and the search copy is excluded from delivery.

## Edit the XML

- Edit `word/document.xml` (and sibling parts) in place with the smallest possible change. **Do not pretty-print or reformat the file**: wholesale re-indentation churns every line, makes diffs and validation baselines meaningless, and risks altering significant whitespace inside `w:t` elements. Parse and write back preserving the original layout wherever the tooling allows; target edits by element/text, not by line number – the XML is usually one enormous line or arbitrary breaks.
- Preserve namespaces and attribute order-insensitivity: match elements by qualified name (`w:...` in the WordprocessingML namespace), never by prefix assumption beyond what the file itself declares.
- Anything you add that needs a new part (image, footnote file, comments) also needs its relationship (`word/_rels/document.xml.rels`) and content-type entry (`[Content_Types].xml`). A part without both is a corrupt package that some readers forgive and Word may not.
- `xml:space="preserve"` on `w:t` whenever your inserted text begins or ends with a space, or Word will trim it before display.

Done when: a diff of scratch vs a fresh unpack of the original shows only the parts and elements you meant to touch.

## Tracked changes essentials

- Insertion: wrap new runs in `<w:ins w:id="…" w:author="…" w:date="…">…</w:ins>` at paragraph level. Deletion: wrap the removed runs in `<w:del …>`. Use `w:delText` for deleted `w:t` and `w:delInstrText` for deleted `w:instrText`. Keep `w:rPr` before run content, for example `<w:r><w:rPr><w:b/></w:rPr><w:delText>old</w:delText></w:r>`.
- `w:id` values for new revisions must be unused integers among existing revisions; dates are UTC ISO-8601 (`2026-11-22T12:00:00Z`). The author string is what coauthors see – use the name agreed with the user.
- A deleted paragraph mark uses `<w:pPr><w:rPr><w:del …/></w:rPr></w:pPr>`. Accepting it prepends any surviving content to the following paragraph, whose paragraph properties govern the result. A paragraph with deleted text and a live mark can survive as a blank paragraph. For an inserted paragraph break, put `w:ins` in the split paragraph's `w:pPr/w:rPr`. In paragraph-mark `w:rPr`, put revision markers before base run properties.
- Formatting-only revisions live in run/paragraph properties as `w:rPrChange`/`w:pPrChange` carrying the previous properties. Put `w:rPrChange` last inside the outer `w:rPr`. Use the rules for the specific property container.
- Keep each revision the smallest range that expresses the change (see redline etiquette in `scientific-documents.md`): replace a word, not the sentence around it.

Done when the redlining check passes and the XML has the intended revision ranges, authors and formatting changes.

## Comments essentials

`$TOOLS/ooxml/comment.py` writes the bodies, thread metadata, durable IDs and extensible metadata, usually in `comments.xml`, `commentsExtended.xml`, `commentsIds.xml` and `commentsExtensible.xml`. It locates those parts through relationships and adds their required relationships and content types. It copies any existing `people.xml` through as-is. New authors get `w:author` and `w:initials` in the comment body only. The helper creates neither a people part nor a person entry. Open the file in Word if people metadata, author identity or the thread display matters to the review.

```bash
PYTHONPATH="$TOOLS" "$PY" "$TOOLS/ooxml/comment.py" ORIGINAL.docx "Comment text" --author "Name" --initials N -o annotated.docx
PYTHONPATH="$TOOLS" "$PY" "$TOOLS/ooxml/comment.py" unpacked-original/ "Comment text" --author "Name" --initials N
PYTHONPATH="$TOOLS" "$PY" "$TOOLS/ooxml/comment.py" annotated.docx "Reply text" --parent 0 --author "Name" --initials N -o with-reply.docx
```

Map any search-copy match back to `ORIGINAL.docx`. Use the ID printed by the helper to place the start before the commented runs, the end after them and a run carrying the comment reference just after the end. Place them in the paragraph. Keep the range within one paragraph unless the comment spans more.

For example, to anchor “target” inside a bold run whose single `w:t` is `before target after`, split that original run into three. Copy its `w:rPr` and existing run attributes to each fragment. Carry over the existing `xml:space="preserve"` and add it on fragments with leading or trailing spaces. For ranges across multiple runs, split only the two boundary runs. Apply this pattern to plain text and inspect fields, revisions, and existing anchors before splitting a more complex run.

```xml
<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">before </w:t></w:r>
<w:commentRangeStart w:id="7"/>
<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">target</w:t></w:r>
<w:commentRangeEnd w:id="7"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="7"/></w:r>
<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> after</w:t></w:r>
```

For replies, the parent comment's last paragraph needs a `w14:paraId`. The helper exits with an error if that ID is absent, as it can be in a legacy comment. Use Word for that reply. For supported parents, the helper checks the saved `w15:paraIdParent` against that ID. After anchoring and repackaging, confirm that link still holds and open the thread in Word when display matters. A headless PDF may omit comments.

Done when the comment ID matches its anchors and reference, and the saved comment part contains the intended author and text. Use `doc.py inspect` for standard paths or read the relationship-resolved parts directly. If Word display is required, verify the anchor there.

## Rezip correctly

- Rezip from **inside** the unpacked directory so `[Content_Types].xml` lands at the archive root – zipping the parent folder nests everything one level deep and the package is unreadable.
- ZIP folder entries gotcha: do not emit explicit directory entries (`word/`, `word/_rels/` as zero-length dir records). The lab validator flags these entries. Write files only, each with its full relative path – the lab `rezip` helper (used by `merge_runs.py`/`comment.py` direct-file modes) does exactly this and stores `[Content_Types].xml` first; prefer it over a hand-written zip loop.
- Write to the final output name only after the zip closes cleanly (write-temp-then-rename, as the helper does), never over the pristine original.

Done when: `zipfile` namelist of the output shows file entries only, rooted at `[Content_Types].xml`, with the same part set as the original plus only intended additions.

## Validate against the original

```
"$PY" "$DOC" validate OUT.docx --original ORIG.docx
"$PY" "$DOC" validate REDLINED.docx --original PRE_REDLINE.docx --author "Name"
"$PY" "$TOOLS/ooxml/docx_feature_inventory.py" --compare ORIG.docx OUT.docx
```

Use a baseline from the same format family. With `--original`, matching relationship defects appear as pre-existing notices. Validation can exit 0 when those defects already occur in the baseline and the other checks pass. Record the part, message and exit status. To confirm a match, validate the original against itself. `--author` activates the text comparison for Word and requires the immediate pre-redline copy as `--original`. It reverses new tracked insertions and deletions across authors in the main document, headers, footers and notes, then compares their extracted text with that baseline. Verify the new revisions' exact `w:author` values, ranges, formatting, fields and anchors in the saved XML.

The inventory reports signed feature deltas by part and lists ZIP part additions, removals and registration changes with their content types and incoming relationships. A loss in one part is counted even if another part gained an element of that kind. For a requested bookmark deletion, use `--allow 'w:bookmarkStart=-1' --allow 'w:bookmarkEnd=-1'`. Allowances are exact totals per kind and direction. Review the full report, including gains and part changes. Comment metadata losses use kinds such as `part:commentsExtended`. The inventory counts live math paragraph marks as `w:oMath` and equations as `m:oMath`. Check the affected instructions, anchors, relationships and equations directly to catch changes that leave counts level.

Done when schema and inventory checks pass, the reported changes match the edit and the render comparison accounts for the changed pages.

## Walkthrough for a plain edit, comment, redline and accepted copy

Use this sequence when the request includes all four operations. Each output becomes the baseline for the next operation.

1. Keep `pristine.docx`. Correct the requested plain text in `edited.docx`, then validate and compare `edited.docx` against `pristine.docx`. Done when the intended text changed in its original run and the feature checks pass.
2. Add the comment body to a copy of `edited.docx` and [anchor it](#comments-essentials) before saving `annotated.docx`. Validate and compare against `edited.docx`. Done when the body, range, reference and registrations agree. Keep `annotated.docx` as the immediate pre-redline copy.
3. Add the requested `w:del` and `w:ins` to a copy of `annotated.docx` and save `redlined.docx`. The example uses Ana Example as the reviewer.

   ```bash
   "$PY" "$DOC" validate redlined.docx --original annotated.docx --author "Ana Example"
   "$PY" "$TOOLS/ooxml/docx_feature_inventory.py" --compare annotated.docx redlined.docx
   ```

   Done when validation passes and each new revision in the saved XML has `w:author="Ana Example"` and the intended range. A passing `--author` validation alone does not establish authorship.

4. If asked to accept Ana's changes, select her name when writing the accepted copy.

   ```bash
   "$PY" "$TOOLS/ooxml/accept_changes_xml.py" redlined.docx --author "Ana Example" -o accepted.docx
   "$PY" "$DOC" validate accepted.docx --original redlined.docx
   ```

   Omit `--author` on the acceptance command only when the user wants every author's changes accepted. [Check the derivative](#resolve-tracked-changes) against `redlined.docx`. Done when the requested changes are accepted and any revisions outside the requested scope are still pending.

## Resolve tracked changes

```
"$PY" "$TOOLS/ooxml/accept_changes_xml.py" redlined.docx -o clean.docx
```

Use direct OOXML acceptance by default. Keep the redline and write a separate derivative. Add `--mode reject` to restore the prior version or `--author "Name"` to resolve one author's revisions. Read the JSON for part names, revision counts and any refusal. The helper covers run, paragraph-mark, move, row, cell and common property changes in the main document, headers, footers, footnotes, endnotes and comments. For paragraph numbering rejection, it needs an explicit old numbering binding in the paragraph property snapshot or a marked numbering insertion. It can also restore a single cached LISTNUM result from a saved prior value. For a refusal, keep the redline and use a Word review workflow for the reported revision.

1. Run `docx_feature_inventory.py --compare redlined.docx clean.docx`. The resolver requires each surviving complex field to keep its original delimiters and nesting. The comparison fails if a part gains malformed fields. For complete fields removed by the edit, allow the verified losses of `field:balanced` and `w:fldChar`, plus any other intended losses. Check the live instructions and cached citation runs, bookmark pairs, comment anchors and thread parts, and equation XML. Check for remaining revisions in every changed story. With `--author`, confirm that pending revisions by other authors survive.
2. Validate against the redline for schema and relationship checks. Render the derivative and inspect the pages with resolved revisions. Compare them with an all-accepted or all-rejected copy made in Word when available. For an author-filtered output, match the reference to that same review scope. If Word is unavailable, check the expected wording, joins and layout in the XML derivative and disclose the missing independent view. A render of pending markup can show both versions of a passage.
3. Use the LibreOffice `accept_changes.py` route only when inspection confirms no fields or review metadata beyond the revisions being accepted. It re-exports the package. Always follow it with the same feature-inventory comparison, validation and render checks.

Done when the derivative has the requested revision state, the feature and validation checks are recorded, and the resolved pages have been viewed.
