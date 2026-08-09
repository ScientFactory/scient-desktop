# PDF reader

Selecting a PDF anywhere that opens a file in Scient opens it in the Files side
panel. The reader uses the full panel by default; the project file explorer and
the PDF pages/outline sidebar remain optional.

The reader supports:

- continuous, fit-to-width reading with bounded page rendering;
- previous/next navigation and direct page-number entry;
- zoom in five-percent steps, one-click actual size, fit width, smooth trackpad
  pinch zoom, and clockwise rotation;
- text selection and copy when the PDF contains a text layer;
- responsive document search after each key, with previous/next result navigation;
- internal document links and external links opened in a separate context;
- existing PDF links, annotations, and form fields in read mode;
- optional virtualized page thumbnails and the document outline;
- password-protected files, progress, invalid-file errors, and a scanned-page
  notice; and
- saving a copy of the original PDF from the secondary actions menu.

The reader does not yet add Scient annotations or OCR. Scanned PDFs without a
text layer can be read visually, but text selection and search may be limited.

Keyboard shortcuts inside the reader:

| Shortcut     | Action           |
| ------------ | ---------------- |
| `Cmd/Ctrl+F` | Open PDF search  |
| `Escape`     | Close PDF search |
| `Cmd/Ctrl++` | Zoom in          |
| `Cmd/Ctrl+-` | Zoom out         |
| `Cmd/Ctrl+0` | Actual size      |

While PDF search is focused, `Arrow Down` or `Enter` advances to the next
match. `Arrow Up` or `Shift+Enter` returns to the previous match.
