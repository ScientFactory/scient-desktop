# PDF reader

Use the PDF reader to study papers, reports, books, and other project documents
while keeping them beside the conversation and related files.

Selecting a PDF anywhere that opens a file in Scient opens it in the Files side
panel. The reader uses the full panel by default; the project file explorer and
the PDF pages/outline sidebar remain optional.

The first time a PDF opens, it starts fit to width with the PDF sidebar closed.
When you return to the same document, Scient restores its page, exact reading
position, zoom or fit mode, rotation, and sidebar mode. This survives leaving and
returning to the conversation, restarting Scient, and refreshed versions that
keep the same document identity. Opening the same
workspace path from another conversation in the same environment shares that
reading session. Files at different worktree paths remain separate. Search text
and PDF passwords are not restored.

The reader supports:

- continuous, fit-to-width reading that remains responsive in long documents;
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
- saving a copy from the secondary actions menu. In the desktop app, Scient
  opens a native Save dialog and confirms when the copy has been written;
  cancelling the dialog leaves the PDF unchanged.

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
