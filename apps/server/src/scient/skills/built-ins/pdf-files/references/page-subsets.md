# Check navigation after selecting pages

Read when splitting or reordering a PDF with links, bookmarks or form widgets. Build a source-page-to-output-page map. Resolve each internal link from the copied pages and each bookmark in the original before deciding what to keep.

For example, select QLoRA pages 1–2. The map is source p. 1 → output p. 1 and source p. 2 → output p. 2. Inspect annotations on the retained pages and distinguish external URI actions from internal `/Dest` and `/A /GoTo /D` destinations. Resolve a named destination through `reader.named_destinations` and `reader.get_destination_page_number()`. For a direct destination array, match its first element to the page's indirect reference in the source page tree. For bookmarks, walk `reader.outline` recursively and resolve each destination's page the same way.

| Source item             | Destination   | Output action                                     |
| ----------------------- | ------------- | ------------------------------------------------- |
| p. 1 link `Hfootnote.1` | Source p. 1   | Keep and resolve to output p. 1                   |
| p. 2 link `section.4`   | Source p. 5   | Record the destination and remove the broken link |
| `Introduction` bookmark | Source p. 1   | Keep and resolve to output p. 1                   |
| `Background` bookmark   | Source p. 3   | Record the destination and prune the bookmark     |
| Two p. 1 URI links      | External URLs | Keep both URLs                                    |

The checked example retained one internal link, two external links and one bookmark. It removed 23 links on retained pages that pointed to omitted pages and pruned the 26 bookmarks whose targets were omitted. Keep a ledger with each removed link or bookmark and its source target. When rebuilding navigation, preserve valid children of a removed bookmark by promoting them as needed. Preserve retained non-link annotations and field relationships when editing a form.

Reopen the output and resolve retained destinations against the output page tree. Check that their page references belong to that tree and their resolved positions match the map. Reconcile external URLs and retained widget field IDs and rectangles with the source. A syntax pass can succeed while an outline still points outside the new page tree.
