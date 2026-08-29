# File previews

File previews let you inspect the project's documents, data, code, figures, and
other outputs without leaving Scient. Files linked in chat open inside Scient
first. Project files keep their editable Files-panel behavior. Files elsewhere
in the connected environment open in a read-only side panel or, for HTML, the
integrated browser.

## Browse workspace files

The Files tree loads folders as you open them. Useful project material remains
visible whether it is Git-tracked, ignored, or named with a leading dot.
Low-level machinery such as version-control data, dependency stores, temporary
caches, and private Scient runtime state stays out of the ordinary view.

The Files menu offers two visibility levels:

- **Project files** is the default. It includes durable managed source files,
  records, receipts, and history below `.scient/sources`.
- **All workspace internals** also shows technical machinery such as
  version-control data, dependency stores, caches, source operations, and
  staging.

The choice lasts for the current workspace session. Managed and tool-owned
files open read-only in Files; use their owning Scient surface when you need to
change them.

Filename search filters the existing tree. Scient uses the project index to
discover matches in unopened folders and loads only their ancestor folders.
Ignored paths that have not been browsed may not appear in search.

What appears in Files does not change what an agent can access and does not add
file contents to a conversation. Those boundaries are enforced separately when
an action reads or shares a file.

In a project file's header, select the project name or any parent folder to
browse that folder, drill into its subfolders, and open a nearby file. The final
file name identifies the current file and is not a navigation control.

Right-click a file tab to copy either its project-relative path or its full path.
For a remote project, the full path belongs to the connected environment rather
than the computer displaying Scient.

Workspace and chat-linked host-file previews follow changes made on disk. The
compact reload action in the file header remains available for an immediate
retry or manual refresh. If automatic updates pause, that action is highlighted
and its tooltip explains that reloading will retry them. A failed read keeps the
last available preview visible while reporting the problem.

Current limitation: automatic refresh follows the exact known path. If the file
is renamed or moved, reopen it from its new location; Scient does not yet
relocate an already open file automatically.

- Markdown files open as rendered documents. Use the source/preview control in
  the file header to switch modes; Scient remembers that preference. A link to
  a specific Markdown line opens source so the requested line can be shown.
- Text files larger than the preview limit open read-only. In rendered
  Markdown, task checkboxes are also non-interactive so a partial preview can
  never replace the complete file.
- HTML files open in the integrated browser. To edit the HTML, right-click the
  file in the file tree and choose **Open source**.
- If the integrated browser is unavailable or an HTML preview fails, Scient
  opens the source instead.

In a project conversation, an agent can also turn an existing project HTML file
into a PDF. Scient builds it with local project assets, opens the generated PDF
in its reader, and preserves the HTML as the editable source. Remote assets are
not loaded during this controlled build, so keep required styles, fonts, data,
and images inside the project. A compatible Scient Desktop must be connected
while Scient performs this Chromium build.

Direct files outside the current project support:

- images, including SVG, with pan and zoom;
- PDFs in the full Scient reader, including remembered reading state;
- rendered Markdown, including math, Mermaid diagrams, and Vega-Lite charts;
- syntax-highlighted source and text, including TSX, Python, MATLAB, R, JSON,
  CSV, and LaTeX source;
- browser-supported audio and video; and
- a stable file-information view for formats that do not yet have a rich
  preview. On the primary desktop environment, the header can still open the
  file in a preferred editor.

Text previews are read-only and limited to 2 MiB. Large files show that limit
explicitly. An optional line target is revealed once after the source view is
ready.

HTML runs normally in Scient's integrated browser, including JavaScript,
network requests, navigation, and relative local CSS, scripts, fonts, data,
images, and media. A packaged site that assumes it is hosted at a web-server
root (for example, references `/assets/app.js`) should be opened through its
development or static server; a standalone local document should use relative
asset paths.

"In the connected environment" is important for remote sessions: an absolute
path refers to the remote host, not the desktop Mac or PC. Remote files can be
previewed through Scient, but desktop-only editor actions are not shown.
