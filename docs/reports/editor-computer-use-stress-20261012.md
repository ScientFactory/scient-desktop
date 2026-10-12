# Editor computer-use stress validation — 2026-10-12

## Result and scope

The bounded LaTeX Visual pass passed the editing, persistence, navigation, and
real PDF-build cases below. It found and subsequently repaired an accessibility
defect: an activated math field could retain its old spoken description after its
formula changed. Five real Chromium regressions pass for the repair. Broader
browser checks also exposed the separate failures documented below; this is not
a claim that every editor feature or platform is qualified.

Validation used the running DocStart candidate from
`scient-desktop-docstart-20261009`, branch `claude/document-start-20261009`, HEAD
`683143a06d9ddfcdc48a5e6f31a2f04c1679f815`, with shared uncommitted changes.
Backend/web ports were 16746/8706. A replacement runtime appeared during setup;
the observed replacement was runner 97877, app 99761, backend 603, Vite 97931.
Neither this pass nor the coordinating lifecycle owner initiated that replacement;
its initiator was not established. No lifecycle commands, compiler installations,
staging, or HEAD changes were performed by this pass. The initial UI pass made no
product-code changes; the subsequent accessibility repair is described below.

Edits used ordinary browser inputs and keyboard events through computer use.
Source verification read the saved files independently; it did not inject editor
state. All editing occurred in the disposable project
`/tmp/scient-editor-stress-20261012`. The existing AAA-NATI manuscript was not
edited; its SHA-256 still matched
`43e050310d024c03c8f01efa14c80473450c4190ddb9985f3bd3a1322283d55e`.

## LaTeX Visual cases

The small fixture declares `% !TEX program = tectonic`, includes
`sections/chapter.tex`, and contains title/author fields, inline math, a labelled
numbered equation, a two-row alignment, a list, a table, and source comments.

| Case                                                   | Observed result                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open the included project in Visual                    | Root prose, included prose, equations, list, and table rendered.                                                                                          |
| Edit the document title                                | Saved the changed title; reversing that edit reproduced the baseline root bytes exactly.                                                                  |
| Title undo/redo                                        | Original and edited title values restored through the actual toolbar.                                                                                     |
| Edit included-file prose                               | Saved the marker in the chapter file; reversing it reproduced the baseline chapter bytes exactly. Root source was unchanged by that prose edit.           |
| Included prose undo/redo                               | Marker disappeared and returned in the rendered chapter.                                                                                                  |
| Edit a table cell                                      | `12` became `1200` in Visual, saved source, and the compiled PDF.                                                                                         |
| Edit inline formula as LaTeX                           | `E=mc^2` became `E=mc^3` in saved source and rendered/compiled math.                                                                                      |
| Edit a numbered display equation                       | The cubic integral and fraction `1/4` saved; its existing equation label remained.                                                                        |
| Edit the included alignment                            | The first result changed from `c` to `d`; both numbered rows remained in Visual and the PDF.                                                              |
| Keyboard bold formatting                               | Cmd+B and typing produced `ROOT-BOLD-MARKER` inside `\textbf{...}` and bold PDF text.                                                                     |
| Save shortcut with Visual focused                      | Browser Cmd+S did not open the composer Stash; edits persisted.                                                                                           |
| Five Source/Visual round trips                         | All ten transitions retained title, chapter marker, bold marker, and formula changes.                                                                     |
| Split view                                             | Saved root source and the included Visual document appeared together.                                                                                     |
| Ordinary Source typing followed immediately by Visual  | A source comment persisted. Removing only that appended comment reproduced the pre-cycle root bytes exactly; chapter bytes remained unchanged.            |
| Real Rebuild after Visual edits                        | PDF.js painted the edited one-page PDF, including title, chapter marker, math, table value, and bold text.                                                |
| Three rapid title replacements, then immediate Rebuild | The PDF used the final title, `Editor Visual Stress Fixture Final`.                                                                                       |
| Deliberate undefined TeX command                       | Build failure was visible with errors; the prior valid PDF remained readable.                                                                             |
| Correct the invalid formula and rebuild                | Build failure cleared; the corrected document produced a new qualified PDF revision.                                                                      |
| Reload the browser                                     | Saved title, table value, chapter marker, and formula changes returned. Reactivated inline math had the correct new spoken label after this full remount. |

The formula-code editor can normalize whitespace inside the edited alignment.
The preservation claims above concern bytes outside the intended edited ranges;
they do not claim unchanged whitespace inside a replaced formula.

## Large-document cases

`large.tex` contains 60 explicit pages, 60 sections/equations, and stable page
markers. Its baseline size was 49,169 bytes.

- Visual reported 60 pages. Jumps to pages 1, 30, 59, 2, and 60 placed the
  corresponding section heading in the viewport; measured heading tops were
  approximately 270–279 CSS pixels in an 820-pixel viewport.
- A paragraph on page 60 accepted `LARGE-LAST-EDIT-20261012`. Toolbar undo removed
  it and redo restored it. The saved file had one marker and 49,195 bytes.
- Removing only that marker reproduced the complete baseline file byte for byte.
- Actual Rebuild produced a PDF independently verified by `pdfinfo` as 60 pages.
  PDF.js rendered page 60 with both its page marker and the saved edit. Independent
  PDF text extraction also contained both markers.

Published evidence matched every live source revision for both fixtures:

| Root        | Artifact                               | Qualified revision                     | PDF bytes/pages |
| ----------- | -------------------------------------- | -------------------------------------- | --------------- |
| `main.tex`  | `47967af5-b9e4-4abe-a5a3-e7ff7489ce11` | `b0c50e02-7900-4866-8baa-4f4841445924` | 27,526 / 1      |
| `large.tex` | `f96d3218-c555-49da-b936-6d5738ebf9a7` | `5302a70e-53df-442a-8852-a06ed42d3a39` | 58,939 / 60     |

These are observed local revisions, not hosted CI or release evidence. The
zero-byte `.pdf` files in the separate SyncTeX index store are intentional
basename markers; PDF validation used `document-artifacts/revisions/.../document.pdf`.

## Findings and calibration

### V-A11Y-01 — stale spoken equation description after an in-place edit

Priority: P2. Reproduced through ordinary browser UI.

1. Activate the original inline formula and edit its LaTeX from `E=mc^2` to
   `E=mc^3`.
2. The visible formula and saved source show the cube, but the math textbox still
   advertises the accessible name ending in “squared”.
3. Similarly, change the displayed integral to `x^3` and `1/4`. Its accessible name
   still describes “squared” and “one third”.
4. Source/Visual mode transitions retained the stale activated-field descriptions.
   A full browser reload followed by reactivation produced the correct “cubed”
   inline description.

The rendered math and PDF were correct. The defect affects assistive technology.
The initial UI pass did not implement a repair; the subsequent repair now updates
the spoken description when the live formula changes.

Root cause subsequently confirmed in the installed MathLive 0.108.2 adapter:
the formula-code textarea publishes new node attributes; `LatexMathField` restores
the existing math model through `restoreMathFieldValue`, with notifications
silenced to avoid publishing the same edit again. That updates the model and
rendered formula without refreshing the separate keyboard sink's accessible name.
MathLive's `defaultAnnounceHook` refreshes that name for the `line` action, which
its focus path invokes; its `setValue` path does not invoke it. Updating the host's
generic “Inline equation” / “Display equation” label does not update this inner
spoken formula label.

Two isolated real Chromium diagnostic cases confirmed this boundary using the
actual Scient restore adapter: `E=mc^2` → `E=mc^3`, and `1/3` → `1/4`. Both
changed the live formula while retaining the previous spoken label. Actual blur
and refocus regenerated “cubed” / “one quarter” without firing another input
event. These two diagnostic cases passed because they assert the defect and its
focus-refresh control; they do not constitute a product fix. Probe source and
output are retained as `mathFieldAccessibility.diagnostic.browser.test.ts` and
`math-label-root-cause-test.txt` in the evidence directory. The temporary test was
removed from the shared checkout after capture.

The repair in `mathFieldAccessibility.ts` reads the existing MathLive model's
public `getValue("spoken-text")` result and updates only the keyboard sink's
`aria-label`. `LatexMathField` calls it after mounting/restoring a field, controlled
source updates, accepted macro updates, and native input. It does not refocus the
field, publish an additional source edit, or replace the model or its history.
The small shadow-DOM adapter is covered against the installed MathLive version.

`LatexMathField.accessibility.browser.test.tsx` uses the actual React component and
browser keyboard/input events. The four core cases failed before the repair;
five cases now pass:

- Inline squared → cubed and display third → quarter source changes update the
  spoken label, preserve source-editor focus, and publish no duplicate edit.
- Backward/forward source revisions keep the spoken label current. This case
  supplies undo/redo revisions; it does not exercise the document toolbar itself.
- Native math keyboard input changes `x` to `x+1`, keeps math focus, updates the
  spoken label, and publishes once.
- Document macro rendering updates from `x` to `y` while the authored macro
  command remains intact. Source and macro edits preserve focus and do not
  publish an extra edit. Speech retains MathLive's existing macro semantics.

Whole-web TypeScript checking passed. Scoped production lint passed with two
existing effect-dependency warnings. Formatting and diff checks passed for the
repair. These are local checks, not hosted CI, and no app refresh was performed.
Before/after regression output is retained in `math-label-regression-before.txt`,
`math-label-regression-after.txt`, and `math-label-regression-final.txt`.

### Broader browser-check findings

A follow-up run of the existing `mathReadingNodeView.browser.test.tsx` produced
five passes and six failures. A control run with the accessibility refresh
disabled reproduced all six failures and the same uncaught MathLive focus error:

- Native formula typing/undo and returning from display math to prose did not
  produce the expected typed text.
- Three local-layout cases observed an unexpected full-measurement mutation.
- Structural paragraph edits did not retain the expected editable-math state.
- MathLive focus raised `Cannot set properties of undefined (setting 'textContent')`.

Both runs used a temporary isolated Chromium configuration and also logged the
fixture server's invalid environment-discovery response. This establishes that
these failures do not depend on the accessibility repair; it does not establish
their product root cause or qualification under the normal full test runner.
They remain follow-up findings. Output is retained in
`math-label-focused-browser-tests.txt` and `math-reading-baseline-control.txt`.

### Native Markdown observations

- Native accessibility `setValue` on the custom Source editor, followed by Cmd+S,
  reached a route error: `InteractionManager.renderSelection: gutter and content
children dont match, something is wrong`. Disk retained the prior saved bytes.
  This path replaced accessibility content without ordinary editor input events;
  it is an automation/accessibility limitation, not proof that normal typing
  crashes or loses data.
- Ordinary native Source paste followed by Cmd+S opened the empty composer Stash
  while autosave still persisted the source marker. This needs a focused native
  shortcut regression check. It was not reproduced by the browser LaTeX Visual
  save-shortcut case.
- An accepted native rich prose edit preserved all bytes outside its edited
  prefix, including math, code, HTML, and Unicode. Native AX selection offsets and
  delayed focus changes made some attempted selections inconclusive; they are not
  counted as product defects.

## Evidence and remaining coverage

Raw evidence is outside repository source at
`/tmp/scient-editor-stress-20261012/evidence`: baseline and step source snapshots,
publication receipts and live-hash checks, the verified PDFs and extracted text,
and screenshots `visual-edited-pdf.png`, `visual-failed-build-retained-pdf.png`,
`visual-reopened-main.png`, `large-visual-page60.png`, and `large-pdf-page60.png`.

Most editing used the restricted temporary Chrome client because native focus
automation was unreliable. The requested inline Scient browser eventually paired
using a fresh incognito tab and snapshot refs. Its new-draft Files panel displayed
“Workspace files loaded” without entries; that path did not qualify inline Visual
editing and remains an unresolved observation. Opening the existing AAA-NATI
thread and its actual file link did load `main-test-6x.tex` in the inline Visual
editor. This read-only follow-up rendered the title and manuscript, reported 104
Visual pages / 17,535 words, accepted distant navigation to the final appendix,
and returned to page 1. Screenshots were retained in Scient browser artifacts.
The 92-page compiled PDF and 104-page Visual estimate are separate measurements.
Browser setup retries and the unexplained runtime replacement are not editor
acceptance evidence.

Cleanup verified that both temporary browser sessions were revoked and no active
pairing grants remained. The task-created Chrome tab and private pairing files
were removed. The inline tab and its screenshots were retained for this chat;
its temporary authenticated access was revoked. DocStart remained running.

Not qualified by this pass: every toolbar command, comprehensive MathLive keyboard
editing, RTL layout, IME input, simultaneous multi-client writes, overnight soak,
all OS/engine combinations, or the separate PDF compilation-setting work landing
concurrently. The confirmed cases are a substantial bounded UI pass, not a
guarantee of an issue-free product.
