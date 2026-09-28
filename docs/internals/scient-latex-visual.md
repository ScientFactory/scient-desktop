# Source-derived writing canvas

Status: implementation candidate; human visual review pending.

## Fidelity target

The writing surface should remain a comfortable CSS-based document editor, with
matching the selected TeX compiler's PDF as a first-class design requirement.
The target is: the latest successfully built revision is exact in PDF mode;
ordinary supported edits update locally and stay as close to TeX as practical;
changes that depend on TeX execution are shown as pending until a rebuild. Do
not imply that an unbuilt edit is final output.

For the CSS surface, derive page size, margins, font family and size, line
spacing, paragraph spacing/indent, headings, lists, math sizing, and supported
table rules from the actual document/build configuration. Prefer build evidence
to source-text guesses when available. Bundle or resolve compatible fonts and
calibrate line breaking, hyphenation, and pagination against representative
compiled PDFs. Keep this evidence revision-scoped so a changed preamble or
dependency cannot silently style a new source revision using an old profile.

Classify edits by their layout reach. Prose and edits inside supported math or
table objects can update the CSS document immediately; local pagination is a
best-effort preview. Macros, packages, document class, global style, references,
floats, and page-breaking commands can affect distant content and need a TeX
rebuild to settle. Keep the current PDF available as the exact last-built
revision, indicate when the source is newer, and adopt a successful rebuilt PDF
without losing the editor's focus or scroll position. Do not compile per
keystroke; any background rebuild policy should coalesce edits and preserve the
last good artifact while it runs or fails.

CSS cannot promise pixel identity for arbitrary TeX: the engine's font shaping,
glue, hyphenation, package code, and global pagination are part of the output.
The practical fidelity strategy is therefore a compiler-calibrated CSS editor
for the supported subset, fast local previews for ordinary edits, and the actual
compiled PDF as the authority whenever exact layout is required. Measure drift
on representative documents before widening the supported subset.

## Current architecture

### Local document workflow

The Documents surface (`scient:documents`) is an additive panel surface. Its
project-scoped hub lists local `.tex` files and creates built-in starters through
the existing `projectEnvironment.writeFile` command with `createOnly`. Template
copies use the existing bounded file reader and remain beside their source so
relative includes retain their base. The backend retains filesystem authority.
Recent-document paths are stored per environment/project in device local storage.
Navigation uses the host's pending-file-save guard and opens documents in Write.

Built-in starters live in `apps/web/src/scient/documents/templates/*.tex`, imported
as bundled text. Creation needs only a filename and Enter; its basename becomes
the default printed title, and a clean article is the default. An optional template
picker stays in the same form. Known filename collisions receive a numbered suffix;
exclusive creation still prevents overwriting files that appear concurrently.
Metadata is escaped and substituted once. Exclusive file publication flushes the
temporary file using a writable handle, as required on Windows, before linking
it to the destination without overwriting an existing file.

The writing toolbar owns a searchable Insert menu, with `/` on an empty
paragraph and Ctrl/Cmd+/ shortcuts. Actions use the existing source adapter and
editor transactions. Figure selection lists project images; citation selection
reads explicitly linked project bibliography files through the existing reader.
Literal BibTeX fields are indexed for selection, not executed or resolved. Object
references and review checks are scoped to the open file. PDF export delegates to
the existing PDF save-copy hook and requires current revision/dependency evidence.
These writing features introduce no hosted service, new compiler, or second save
path. Project creation remains owned by the project sidebar.

The compact writing bar reuses Markdown's dock controls and shared table-size
picker. Document settings, outline, and review live in the document header.
Title/author/date remain editable on paper, with visibility controls in the
contextual footbar and restoration from Document settings. Heading numbering and
reference labels, table structure, figure properties, and statement properties
also belong in that footbar; focusing an object does not insert controls into
the page. Standard article/report/book classes can be selected in Document
settings; incompatible switches and custom classes stay protected.

### Source code editing

Source uses the inherited `EditableFileEditor` from the shared file surface. Its
edits and the Visual editor publish to the same revision-checked save coordinator.
Split places Source on the left and PDF or Visual on the right. The last selected
right-side view is stored locally, including selections made in a standalone view;
PDF is the default. A source-line double-click in Source + PDF uses the existing
SyncTeX authority with an unknown column. Failed builds retain the last good PDF.

### Source and editing

`.tex` is authoritative. `latexVisualDocument.ts` projects supported source
ranges into a disposable ProseMirror model. `LatexVisualEditor.tsx` uses the
existing Tiptap editor stack for native selection, composition, formatting,
lists and undo. MathLive supplies structured math input; fonts are bundled
locally, sounds and the optional compute engine are disabled. No web service
or TeX process participates in a writing transaction.

The transaction guard verifies the exact source generation and validates the
changed block. Immutable ProseMirror nodes cache their JSON and signatures; plain
text and object edits reparse only their replacement block. Structural changes
and document-context changes retain a whole-document validation fallback. Unchanged source, comments, preamble and opaque blocks remain
byte-for-byte intact. The session retains editor whitespace and undo across
local transactions; adopting external source resets editor history so Undo
cannot replay an edit from an obsolete revision. Bounded inline text changes preserve original command aliases, dash spelling,
nonbreaking spaces and soft line breaks. Structural changes may serialize the
changed block; unaffected blocks remain exact. This is a bounded source adapter, not a complete TeX
parser or macro evaluator. Category-code changes fail closed.

Plain object fields retain exact local text and caret position while accepted
changes pass through the same source guard. Whitespace is compared using TeX
semantics without trimming the live field. Composition and rejected intermediate
input remain local; document-scoped field journals retain unacknowledged drafts.
Source acknowledgements do not replace the focused field. Accepted edits share
document undo; incomplete field text keeps its native undo. A draft indicator
distinguishes uncommitted field text from saved source, and PDF rebuild/export
wait for active field drafts to be resolved. Custom formatted metadata remains
protected rather than being flattened into plain text.

Source and Visual use one `useFileSaveCoordinator` and its existing compare-and-set
writes, with the existing 500 ms debounce for both views. The recovery journal
retains one accepted source copy and its base revision in memory, then coalesces
local storage writes on a 200 ms leading deadline. There is no synchronous
document hash on the input path or migration chain for retired overlay formats.
Recovery offers Restore and Dismiss; Restore uses the same revision-checked
workspace save path. Storage failures are reported without blocking workspace
saves. Moving this remaining journal onto the shared document session is a
separate integration step in the proposed editing foundation.
Autosaving continues while the writing surface is focused. Conflicts use the
existing explicit retry/discard workflow. Rebuild is disabled until saves
finish, and cannot run while a known save error or conflict is unresolved.

`LatexBuildService.status` verifies dependency evidence but never starts a
compiler. A stale status keeps the old artifact readable, marks its descriptor
stale and removes visual source authorization from that response. The client
does not build on open, save, focus change or completed toolchain installation.
Only explicit rebuild requests (including agent tools) start TeX. Existing
root resolution, cancellation, bounded compile stabilization, immutable
artifacts and PDF navigation remain owned by the existing build/reader path.

Visual uses browser-rendered paper with CSS pagination; PDF and Split with PDF use the
actual PDF with navigation. Supported tables and selected scientific structures
have structured editors. Browser output remains approximate: a successful build
does not make the browser execute arbitrary macros or guarantee compiler-identical
typography and pagination. Macro/preamble changes produce rebuild guidance.
Incremental TeX, arbitrary macro rendering, and a general TeX-to-editable-content
adapter are not implemented.

### CSS page layout

`latexVisualLayout.ts` owns the supported layout profile. It reads top-level
class/package options and explicit geometry and spacing commands, ignoring
comments and command bodies. Paper dimensions remain in inches and typography
in TeX points until conversion to CSS pixels. The standard-class measurements
follow LaTeX's [classes.dtx](https://github.com/latex3/latex2e/blob/main/base/classes.dtx);
custom class code, font metrics, package effects and macro expansion still need
the compiler. This is source interpretation, not compiler-extracted metadata.
First-level `enumitem` settings supply list spacing and indentation. Table
presentation reads standard font-size switches and literal paragraph-column
widths from preserved source, including empty outer `@{}` separators. Captions
remain at the surrounding text size and wrap independently of cell text.

`latexVisualPaginationExtension.ts` owns view pagination. It measures browser
text lines, keeps headings with following content and pairs lines at paragraph
boundaries, and supplies ProseMirror decorations for page spacing. A paragraph
can continue on another sheet without splitting its source block. Tall supported
tables receive presentation gaps between rows through node-view decorations;
their cell editors retain stable row identities. Ordinary tables and equations
stay together when they fit on a sheet. A single object or table row taller than
the printable area is still an overflow limitation; this does not reproduce
TeX's float algorithm or longtable running headers.
Description lists and contents lists can break between entries. Description
labels and bodies use the document baseline; `nextline` wraps the body only
when the label cannot fit beside it, following
[enumitem's description styles](https://github.com/jbezos/enumitem/blob/master/enumitem.tex).
The symbol palette uses `mathSymbolCatalog.json` for command membership and
Unicode/package metadata, checked against the math panels in LyX's
[`lib/ui/stdtoolbars.inc`](https://raw.githubusercontent.com/cburschka/lyx/master/lib/ui/stdtoolbars.inc)
and [`lib/symbols`](https://raw.githubusercontent.com/cburschka/lyx/master/lib/symbols)
on 2026-09-24 (827 entries in 20 groups). These are command and symbol facts;
Scient supplies its own layout, labels, selection-aware insertion templates, and
keyboard interactions. `mathSymbols.ts` also supplies source completions and
package requirements. `mathSymbolPresentation.ts` caches local glyph previews;
Unicode display macros retain their original LaTeX command on serialization.
Commands without an editor glyph are explicit source entries. Palette preferences
contain symbol IDs only and live in local storage. Package additions pass through
the same source transaction and projection guard as the math edit.

Math, title, and table controls share a contextual slot in the document status footer,
which keeps a constant height. A shared activation event closes the previous
object's controls. `LatexTitleView.tsx` keeps native text editing on the paper;
author visibility and date mode live in the footer. Hiding an author writes
`\author{}` and retains the hidden name in the document's local app preferences.
Showing it restores `\author`. No new app metadata is written into the LaTeX
source. Legacy hidden-author comments remain readable and are removed when the
author is edited. Restoring a hidden name therefore depends on the local app
preferences when no legacy comment is present. The palette uses LaTeX-specific CSS classes to
avoid collisions with the shared math-input popup. Its code popover is attached
to the footer controls, outside the scaled document. It edits the formula body only and publishes
supported changes through the existing source guard as the user types. Outer
wrappers stay under the equation-type selector; rejected drafts are marked as
unsaved. Inner-environment completions omit display wrappers.

Item controls stay outside measured flow. Inline math uses MathLive's
`inline-math` mode and does not reserve input-field padding around every formula.
The MathLive dependency patch keeps command suggestion rows mounted while the
highlight changes, reuses their rendered previews, and scrolls only the menu
instead of the document. The menu appears synchronously without delayed callbacks
that can reopen an obsolete popup. Rows have a fixed height and stable scrollbar
spacing. Both development and production browser exports use the patched readable
bundles; the application bundler handles production minification.

Pagination metadata never enters document JSON, the recovery journal, undo, or
source serialization. Measurement caches unchanged paragraphs, responds to font
and object resizing, waits for composition to end, and preserves a visible text
anchor during reflow. `LatexTableToolbar.tsx` keeps row, column, and table actions
in footer menus, including caption and label fields. Activation spans the table
and its portaled controls, so moving focus between them retains the active cell.
Table selection adds no controls or visual decoration to the paper. Row and
column insertion avoids existing IDs; cell keys follow column IDs when reordered.
Blank cell space forwards focus to the cell editor without resizing the table;
clicks on text retain native caret placement. Empty cell insertion preserves a
separator after TeX rule commands, and cell/caption round trips normalize TeX
whitespace while retaining the user's exact text in the editing session.
The long-lived ProseMirror guard calls the current source adapter through a
ref so renderer hot updates do not retain obsolete validation logic.
The outline starts collapsed, and the status bar follows the visible page.
The canvas has no ruler above the paper. Native interaction and PDF comparison of
these changes remain unqualified until manual review; no tests were run for
this layout pass at the user's request.

Unit tests cover source-range integrity, whitespace, headings, nested lists,
empty paragraphs, math, escaping, protected syntax and rebuild notices. Build
service/store tests cover observational status and explicit compilation.
Running-candidate checks and remaining qualification gaps are recorded in the
PR handoff. Human review is required before merge.

## Root context and source coverage

Write uses the resolved root's preamble for chapter layout and its directory for
figure paths. An unknown root leaves figure paths unresolved. Root documents add
newly required figure, table and math packages to their own preamble. In included
files, an insertion that would require changing the root is declined with guidance;
there is no uncoordinated second file write. The default table is package-free.
Supported table structural operations retain each surviving cell's source and
formatting by row and column identity. Labels are identifiers, not escaped prose.
Page settings write only the requested fields. Hidden author text stays in app
preferences rather than private comments in the preamble.

The parser intentionally leaves unknown commands, optional citation arguments,
control symbols, comments inside prose, custom macros and unsupported table cells
as source-only blocks. Simple templates do not establish arbitrary-paper coverage.

Export freshness reuses the revision-scoped dependency hashes in the build evidence.
There is no second visual revision manifest or PDF-overlay interaction host. The
Write editor loads lazily; Source uses the shared file editor and does not load MathLive.

## Adapter direction

Expand coverage through bounded command/environment adapters that own recognition,
source mapping, rendering, round-trip validation and package requirements. Use the
same adapter capabilities for insertion and editing so controls cannot promise an
unsupported edit. Compiled measurements may refine presentation, but never authorize
source mutations from PDF coordinates. The shared Markdown/LaTeX foundation proposed
in PR #373 remains a proposal; these fixes do not adopt a new framework or persistence
architecture ahead of that decision.
