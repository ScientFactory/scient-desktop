# PDF reader

Use the PDF reader to study papers, reports, books, and other project documents
while keeping them beside the conversation and related files.

Opening a workspace or environment PDF uses the Scient reader in the Files side
panel. The reader uses the full panel by default; the project file explorer and
the PDF pages/outline sidebar remain optional. PDFs attached to a chat message,
including attachments you are still composing, open in the same reader. Browser
tabs keep their own viewer.

The first time a PDF opens, it starts fit to width with the PDF sidebar closed.
Zoom stays fixed while scrolling between pages, including mixed portrait and
landscape pages. Click Fit width again to fit the current page. Resizing the
reader pane still adjusts the document to the available width.
Each conversation keeps its own PDF reading position. A fork starts from the
original conversation’s position; navigating either conversation afterward does
not move the other.

When you return to the same document, Scient restores its page, exact reading
position, zoom or fit mode, rotation, and sidebar mode. This survives leaving and
returning to the conversation, restarting Scient, and refreshed versions that
keep the same document identity. Reading state stays separate between
conversations, even for the same workspace path. Files at different worktree
paths also remain separate. Search text and PDF passwords are not restored.

The reader supports:

- continuous, fit-to-width reading that remains responsive in long documents;
- previous/next navigation and direct page-number entry;
- zoom in five-percent steps, fit width by clicking the zoom percentage, actual
  size, and smooth trackpad pinch zoom;
- text selection and copy when the PDF contains a text layer;
- responsive document search after each key, with previous/next result navigation;
- internal document links and external links opened in a separate context;
- existing PDF links, annotations, and form fields in read mode;
- optional virtualized page thumbnails and the document outline;
- password-protected files, progress, invalid-file errors, and a scanned-page
  notice; and
- saving a copy from the secondary actions menu. In the desktop app, Scient
  opens a native Save dialog and confirms when the copy has been written;
  cancelling the dialog leaves the PDF unchanged.

## Ask in chat about a passage

Select text in a PDF and choose **Ask in chat**, as in code and Markdown files.
The quote becomes a chip in the message you are writing, with an optional
comment. The agent receives the PDF's path or name, the page, the quoted text
and a little text around it.

- A selection can span up to four consecutive pages. When a selection can't be
  quoted (diagonal text, a page still loading, more than four pages, or a quote
  too long for one message), the button says why instead.
- Click a quote chip, in your message or a sent one, to reopen the PDF at the
  quote with it highlighted. If the PDF has changed since, Scient looks for the
  quoted text and tells you whether it found it, found it more than once, or
  couldn't find it; then it opens the page where the quote was.
- PDFs in the Files panel, LaTeX output, generated PDFs, Sources papers, files
  outside the project and sent chat attachments can be quoted. An attachment
  you are still composing can't be quoted yet; ask about it in words, or quote
  it once the message is sent.

## Page changes

The existing Pages sidebar also supports small edits, without an editing mode.
Clicking a thumbnail still navigates. Its inset corner checkbox selects the page;
the checkbox beside Pages selects all and shows a dash for a partial selection.
Shift-clicking checkboxes selects a range. Ctrl/Cmd+A selects all only while focus
is in the sidebar.

Right-click opens the menu without changing the checked pages. Right-click a
checked page to act on the checked group, or an unchecked page to target only
that page. The menu offers Rotate (left/right 90°), Move…, Duplicate, and
Delete, in that order. Move… opens a compact popover beside the thumbnail with
one Before page number field. Enter a page
number from the current document; the number after the last page moves to the
end. Move saves immediately and supports undo. Copies appear after the last
checked page. At least one page must remain. Rotation changes the saved PDF; the old view-only Rotate
clockwise item is removed from More.

Any thumbnail can be dragged. Dragging an unchecked page moves only that page,
keeping other checked pages unchanged. Dragging a checked page moves the checked
group in document order, with a stacked preview showing the number of pages.
An insertion line marks the destination, and dragging near the sidebar edges
scrolls it. Checked boxes have a solid gray fill.

Hover or focus a gap to reveal a small gray Lucide CirclePlus icon.
These controls overlay the existing thumbnail margins and add no spacing. The +
menu offers Blank page and From PDF….
A blank page matches the adjacent page's visible size and orientation.
From PDF… opens a file picker, then a compact All pages / Range popover.
Insertion uses the chosen gap directly. Moving pages is available through Move…
in the page's right-click menu or by dragging.

Edits save immediately to the file's environment, including undo and redo.
Ctrl/Cmd+Z undoes the last page change; Ctrl/Cmd+Shift+Z or Ctrl+Y redoes it.
Text fields keep their own undo and selection shortcuts. History is kept in
memory while the document's editing session remains open.

Generated PDFs are immutable build outputs: their first page edit automatically
creates a separate edited document. Files outside writable project folders also
use an edited copy. Scient remembers the copy for this conversation and opens it
when you return to the original document. Use Show original / Open edited copy
to switch between them, or Save copy to export the edited PDF as a local file.
Subsequent edits save new revisions of the copy; LaTeX rebuilds own the original.
Chat attachments remain read-only; save them to your project to edit their pages.
The backend checks the expected file revision before replacing bytes and uses
the host's supported file-publication method. If another application changed
the PDF, the edit is refused.
Use Reload PDF in the error notice to read the latest file and reset page history.

Page edits support up to 5,000 pages and 50 MB of combined source PDFs.
Encrypted PDFs and PDFs with form fields or certificate permissions stay
read-only. Existing base-document outlines, internal destinations, metadata,
and attachments are retained; destinations to removed pages follow a surviving
page. Imported internal links are retained when their target is also inserted.

The reader does not yet add Scient annotations or OCR. Scanned PDFs without a
text layer can be read visually, but text selection and search may be limited.

Keyboard shortcuts inside the reader:

| Shortcut     | Action               |
| ------------ | -------------------- |
| `Cmd/Ctrl+F` | Open PDF search      |
| `Escape`     | Close PDF search     |
| `Alt+Up`     | Zoom document in     |
| `Alt+Down`   | Zoom document out    |
| `Alt+0`      | Document actual size |

While PDF search is focused, `Arrow Down` or `Enter` advances to the next
match. `Arrow Up` or `Shift+Enter` returns to the previous match.

On Mac, Alt is Option. Customize document commands under **Settings → Shortcuts → PDF**.
Toolbar hints show your effective bindings.
Document zoom deliberately differs from `Cmd/Ctrl++`, `Cmd/Ctrl+-`, and
`Cmd/Ctrl+0`, which remain browser/application zoom. Those native menu keys can
be intercepted before a document receives them; prefer a non-reserved custom key.
`Cmd/Ctrl+Shift+F` does not open PDF Find.
