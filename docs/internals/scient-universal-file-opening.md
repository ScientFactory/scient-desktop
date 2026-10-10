# Scient universal file opening

## Product contract

A primary click on a file link in chat opens the file inside Scient first.
Workspace files retain the inherited editable Files panel. A file outside that
workspace opens in the same Files panel, read-only, by its absolute path,
except HTML, which opens in the existing integrated Browser because Browser
already owns navigation and executable page state. The context menu retains
explicit editor and Browser actions. The separate Scient right-panel file
surface still exists for tabs saved before host files moved into the Files
panel; nothing new opens in it.

Explicit relative Markdown file destinations support Unicode and punctuation
in names, including `Report (readable).md` and `סיכום.md`, without requiring a
`./` prefix. They resolve against the current workspace (or the containing
document's directory in a file preview). URL schemes and app routes retain
their existing handling, and inline-code auto-linking retains its stricter
path evidence. Failed file opens use the existing Files panel error state;
recognizing these destinations does not add chat errors or notifications.

The result is universal routing, not a claim that every binary format already
has a bespoke renderer. Every valid regular file has a useful in-app outcome:
a rich adapter when one exists and a minimalist metadata/fallback surface when
one does not. Generated chat images and analysis artifacts keep their existing
specialized cards and panels; this feature does not regress or redirect them.

## Environment authority and preparation

`filesystem.prepareFileOpen` is the single inspection boundary. The connected
server, not the browser UI, interprets the path. It requires an absolute path,
resolves symlinks to a canonical regular file, reads at most 64 KiB for
classification, and returns only serializable presentation metadata. Missing,
directory, unreadable, and inspection failures remain typed RPC errors.

This makes local and remote behavior honest:

- in the primary environment, a path identifies a desktop file; and
- in a remote environment, the same-looking path identifies a file on that
  remote host.

One known exception remains: when a remote environment reports an absolute
image, video, or audio path as unavailable, the web client retries that same
path on the primary environment (`packages/client-runtime/src/state/assets.ts`).
That can show a file from the viewer's own machine in place of the remote one.
It is a correctness limit to remove, not a behavior to rely on.

## Paired and remote viewers

Owner decision (2026-10-01): a paired or remote device may open as much as the
host can read. There is no locality-based read restriction, and none should be
added. What bounds a viewer is the same for every client: the session scope
(`orchestration:read` covers reading, watching, preparing, link repair, and
asset URLs), the signed asset capability, the formats a client can render, and
the HTML document-root rules below.

Because the host's own applications are out of reach for a viewer on another
machine, anything Scient cannot render can be taken to the viewing device:
"Save a copy" requests the `exact` environment-file capability for that one
file and hands it to the native Save dialog on desktop or a browser download.
Actions that happen on the host's screen (open in an editor, reveal in the
file manager) remain host actions.

Classification prefers content signatures for PDF and common images, then
uses decoded text plus the extension. UTF-8 and BOM-marked UTF-16 are supported.
Text and Markdown transport is range-bounded to 2 MiB and decoding preserves a
valid prefix if the range ends within a multibyte character.

## Presentation adapters

| Prepared kind  | In-app presentation                                            |
| -------------- | -------------------------------------------------------------- |
| workspace file | Existing T3 Files panel and editor behavior                    |
| image or SVG   | Existing zoomable `PreviewImageSurface`                        |
| PDF            | Scient PDF reader through `PdfSourceDescriptor`                |
| Markdown       | Existing `ChatMarkdown` pipeline and rich fences               |
| text/source    | Existing read-only Pierre virtualized source renderer          |
| HTML           | Existing integrated Browser with read-only source fallback     |
| audio/video    | Native Chromium controls and range transport                   |
| unknown binary | File name, MIME type, size, refresh, and desktop editor action |

The thread-scoped surface persists only the requested absolute path and an
optional line; the thread supplies environment authority. It never persists an
expiring URL. One shared exact-file subscription per environment and canonical
path invalidates every mounted consumer; watcher readiness closes the
inspection-to-subscription race, and later changes rerun inspection and renew
transport. Until inspection succeeds, the requested absolute path is watched so
creation of a previously missing file can recover the preview. Manual reload
remains an explicit recovery path and restarts the subscription. Direct PDFs
use environment plus normalized canonical path as logical identity, so URL
renewal and thread changes preserve reader state while identical paths in
different environments remain isolated.

## Viewing is independent of the workspace boundary

Where a file lives decides only whether it is editable, never whether it can be
viewed. `projects.readFile` and its change subscription read a host file in
place, read-only, however the path is spelled: an absolute path, a relative
path that climbs out of the workspace, or a symlink inside the workspace that
leads out of it. Only the viewer's read (`WorkspaceFileSystem.viewFile`) is
relaxed. `readFile`, which export, analysis, compute, saves, and renames use to
work on project files, still keeps a relative path inside the root, symlinks
included; a rename confirms its destination with it. Writes, renames, and
creates keep every containment check. A
workspace asset request for such a symlink is served as that exact target
alone, the same capability an absolute media path grants, with no sibling
access.

The client resolves `..` in an absolute path before deciding whether it is
inside the workspace, so `<root>/../notes.md` is a host file rather than the
workspace path `../notes.md`. The files panel applies the same rule to a tab's
path, which also repairs tabs persisted before this rule existed. The only
reasons a file cannot be shown are that it does not exist, that the operating
system denies the read, or that it is not a regular file; each is reported as
itself. A successful read of a file that lives outside the workspace says so
(`outsideWorkspace`), so the read-only line can give that as the reason. Read
failures carry the operating system's reason (`not_found`,
`permission_denied`) as an optional refinement of `operation_failed`, and the
system's own error code (`osErrorCode`) beside it. The code is an optional
field rather than a wider reason union so that older clients still decode the
error. A client says only what the code states: `EACCES` is a permission on the
file or its folders; `EPERM` is the system declining, which on macOS is usually
but not provably its privacy protection, and is a setting on the host.

### Paths are identifiers

A file path names one exact file, whitespace included: `notes.md ` and
`notes.md` are different files. Project file contracts therefore carry paths
as given (`FilePathString`, `DirectoryPathString`) through listing, search
results, read, watch, save, rename, their error contexts, and workspace asset
locators, and the server resolves them as given. A blank path is rejected; the
empty string still names the root directory. Workspace roots, filesystem
discovery, favicon paths, and attachment names keep their existing trimming.
Text a person types for a new name is trimmed where it is typed. A peer that
predates this still trims, so exact names are guaranteed only when both sides
are current.

### Known limit: containment is checked, then paths are used

Saves, creates, and renames validate that their target is inside the workspace
and then operate on path strings; reads decide whether a file is editable from
a resolved path before opening it; folder creation and rename cleanup are also
by path. A process able to replace a workspace folder with a link at the right
instant can therefore redirect them outside the workspace. Node exposes no
directory-relative file operations, and a design review showed the gap cannot
be closed with in-process path calls (a staging folder is itself a path the
same process can move). Closing it needs operations relative to a held
directory, in a helper process or native code, and is tracked as its own
change.

## Link repair

Agents write links relative to the directory their shell was in, or to a
folder they were thinking in, which Scient cannot see. `filesystem.resolveFileLink`
is the single place that decides what a chat link means, and it runs on the
environment that owns the files:

1. The link as written wins whenever its location exists, or fails for any
   reason other than absence. `..` is applied to the path as written, as the
   shell and the path tools that built the link apply it.
2. Only when nothing exists there is the workspace searched for files with the
   link's exact name. The search walks the workspace's real path, so it
   includes symlinks to regular files, which the file index does not list. It
   does not enter symlinked directories, `.git`, or `node_modules`, checks each
   directory against its own real path, and is bounded in directories and
   time. It is a snapshot: the best candidates are checked again before the
   answer is given, and anything that could not be examined makes the result
   incomplete.
3. The candidate sharing the longest run of trailing path segments with the
   link is the match. Several at that length are a tie, unless exactly one is
   a file the link's own turn changed.
4. The result is `literal`, `recovered`, `tie`, `none`, or `incomplete`. A
   click opens a `recovered` file; every other outcome opens the link as
   written, and the files panel offers the candidates as choices. An
   incomplete search never yields a match. A repaired open is not announced
   (owner decision, 2026-10-01): the tab and its breadcrumb show which file it
   is, and extra explanatory text was judged noise.

A link written from the home folder (`~/notes.md`) means the home folder of
the machine that owns the files, which a viewer on another device cannot know.
The resolver expands it there, after checking that the workspace has no entry
really named `~`, and the client opens the location it reports.

Chat links and links inside the rich Markdown editor both go through this
resolver. A tab's own path is a location, not a link: a workspace folder
really named `~` is joined to the workspace root (`workspaceFileHostPath`) and
asked about by its host path, never expanded as the home folder.

Link repair is a best guess about what a link's author meant. It is
not file identity: it proves nothing about a file that moved, and the files
panel never applies it by itself to a tab whose file disappeared.

## Current identity and relocation limit

The current contract is exact-path reliable but path-bound. If a watched file
is renamed or moved, the old path can report missing and later recover if a
file reappears there, but Scient does not yet prove that a different path is
the same logical file. Direct and workspace entry points also use related but
separate presentation dispatch.

The proposed
[file/resource/presentation foundation](https://github.com/ScientFactory/Scient/blob/main/docs/planning/file-resource-and-presentation-foundation.md)
would add stable `FileReference` identity, bounded relocation evidence,
explicit ambiguity recovery, and one presenter registry/shell. It must preserve
the current environment authority, canonicalization, signed-asset transport,
editor conflict protection, PDF logical identity, HTML document-root policy,
watcher behavior, and typed failure states. It must not treat a stale absolute
path, filename-only match, or workspace-wide scan as sufficient proof of
identity.

## File transport and HTML documents

`AssetResource.environment-file` has two explicit modes:

- `exact` issues a signed, one-file, revision-pinned capability. The route
  supports HEAD and byte ranges. If size or modification time changes, the
  stale URL returns 409 and the client renews it once.
- `html-document` issues a signed capability rooted at the canonical directory
  containing the entry document. Chromium can therefore request normal
  relative scripts, styles, fonts, data, images, media, and nested pages. These
  responses use `no-store`, so Browser reload reflects local edits immediately.
  The document capability lasts 24 hours because silently renewing its URL
  would reload the tab and discard interactive state; reopening the file issues
  a fresh capability. Exact file capabilities keep the one-hour renewable TTL.

The Files panel uses the same `html-document` mode when it shows a host HTML
page in its own frame, so a viewer without the integrated Browser (a browser
tab, a remote desktop) sees the page with its stylesheets, scripts, and images.

The HTML mode deliberately preserves JavaScript and normal Browser networking;
it is not the old inert-document renderer. Each request is canonicalized again,
must resolve to a regular file inside the document directory, and cannot use
parent traversal, absolute paths, hidden sibling paths, or symlink escapes. The
entry document itself may be hidden. Malformed HTML and missing resources use
Chromium's normal recovery and network/error behavior rather than producing a
synthetic black viewer state.

Root-relative web-server URLs such as `/assets/app.js` are not reinterpreted as
local filesystem paths. Such bundles need their intended local dev/static
server. Rewriting arbitrary HTML, CSS, and runtime-generated URLs would be
incomplete and would create a second browser implementation.

## Ownership and upstream maintenance

Scient owns the contracts, preparation service, asset capability, presentation
adapters, right-panel descriptor, breadcrumb navigator, and shared file-path
clipboard behavior. Universal file opening and file-path affordances touch five
inherited T3 files:

1. `ChatMarkdown.tsx`: primary-click routing for workspace versus direct files,
   the HTML Browser action, and delegation to the shared path-copy handler.
2. `ChatView.tsx`: one lazy mount for the Scient file surface and the active
   workspace root supplied to right-panel full-path copying.
3. `rightPanelStore.ts`: the existing `openScient` branch refreshes a matching
   Scient descriptor in place, so reopening one file at a new line updates the
   reveal target without creating another tab.
4. `FilePreviewPanel.tsx`: one mount replaces the inherited display-only
   breadcrumbs while preserving the current-file scroll marker and the existing
   editor/save lifecycle.
5. `RightPanelTabs.tsx`: the existing file-tab context menu offers relative and
   full path copying through the shared handler.

The inherited editor/save lifecycle, Browser manager, and attachment/image paths
are unchanged. The workspace viewer consumes the same native watcher stream
through one Scient-owned hook, preserving optimistic edits and revision-conflict
handling while exposing watcher failure and restart at its existing reload
control. T3's workspace-mutation hook is a fallback inside that same owner when
the watcher is unavailable; it waits for pending source edits to settle and
invalidates binary previews as well as text. It does not create a second active
refresh loop beside a working watcher. The lazy Files tree, Git status, and
working diff consume the upstream mutation hint directly.
Static seam tests guard the file-opening boundary, while focused
component tests pin the additive breadcrumb, freshness, and clipboard behavior.
If T3 later provides an extensible file-presentation registry, Scient should
adapt these owned presenters to it and retire the host seams.

The breadcrumb picker is shared by browser and desktop file previews and uses
the existing ignore-aware `projects.listEntries` cache. File-tab copy actions use
the native desktop context menu or the browser fallback. Mobile retains its
existing single `Copy path` action, and the file explorer tree remains unchanged;
those surfaces require separate product decisions rather than implicit parity.

Until that registry lands, new rich formats should extend preparation metadata
and add a Scient-owned presenter without adding producer-specific branches to
the reader or widening inherited dispatch unnecessarily. Office/manuscript
documents, notebooks, TIFF/HEIC, scientific datasets, and future Artifact
Studio representations can therefore arrive incrementally. Producers continue
to own durable identity and provenance; this opener owns only inspection,
authorization, routing, and viewing.

## Verification contract

Backend coverage must pin classification, bounded inspection, symlink
canonicalization, typed path failures, exact range transport, revision renewal,
HTML script/data MIME handling, traversal and hidden-path rejection, symlink
escape rejection, token tampering, and authorization scope. Web coverage must
pin persisted surface normalization, PDF identity across threads and
environments, repeated line-target replacement, incomplete multibyte decoding,
explicit HTML capability use, and the five narrow inherited host files above.
Typechecks and production builds verify the RPC and lazy-chunk boundaries.

Manual acceptance should cover light and dark themes, empty and large text,
line links, corrupt images/media, PDF state restoration, interactive HTML with
local assets, missing HTML assets, malformed HTML, an unsupported binary, and
the same cases through a remote environment.
