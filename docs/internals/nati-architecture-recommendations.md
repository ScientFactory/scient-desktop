# Nati architecture recommendations

Status: product and architecture recommendations for future scoped work. This
document does not describe behavior implemented by the current pull request.

## Desired experience

Scient's LaTeX workspace should feel like a comfortable document editor between
Google Docs and LyX while keeping `.tex` as the authoritative file. The writing
view should be useful without running TeX after every edit. An explicit rebuild
should produce and display the exact PDF, including package behavior, macro
expansion, references, pagination and final typography.

The browser writing view and the compiled PDF have different jobs:

- The writing view owns fast input, selection, undo, structure and approximate
  layout.
- The TeX toolchain owns exact typesetting and the final PDF.
- Scient should state clearly when the writing view is approximate and what an
  explicit rebuild will verify.

Attempting to make arbitrary TeX execute continuously inside an editable browser
surface would recreate much of a TeX engine and still would not make arbitrary
output safely invertible. Improvements should therefore expand a bounded,
source-preserving projection rather than fork the TeX compiler.

## 1. Math should read like output and reveal source on demand

In normal writing, inline and display math should appear close to its final
typeset result. Selecting or clicking a math object should open a small anchored
popover above it. The popover should show the complete source representation,
including its delimiters or environment wrapper, for example:

```tex
$x^2 + y^2 = r^2$

$$
E = mc^2
$$

\begin{equation}
  E = mc^2
\end{equation}
```

The popover is an editing affordance layered over the document; opening it must
not replace, resize or rewrite the visible rendered formula. It should support
both structured math input and direct source editing. Changes should commit as
one undoable transaction, and Escape should cancel them.

The model must retain the original delimiter style and environment wrapper when
possible. Merely storing a normalized formula body is insufficient because `$`,
`\(`, `$$`, `\[`, `equation`, `align` and related environments can carry
meaningful source conventions. If an edit requires normalization, the UI should
make that explicit rather than silently changing unrelated source.

Math rendering in the writing view may use MathLive/KaTeX-style layout for fast
feedback, but only a TeX rebuild can claim exact package, font, numbering,
spacing and pagination fidelity.

## 2. Grow command coverage through explicit adapters

The writing view currently cannot interpret many commands. Unknown source must
remain protected and byte-preserved, but the long-term goal should be to make
more of it readable and editable.

Use a command and environment adapter registry rather than a single expanding
parser switch. An adapter should define:

- recognition and bounded source parsing;
- the structured editor node and approximate renderer;
- source serialization and preservation rules;
- whether direct editing is safe;
- dependencies on packages or document context;
- tests for parsing, editing, round trips and unsupported variants.

Useful first tiers are:

1. Common semantic commands such as emphasis, links, labels, references and
   citations.
2. Common mathematics such as fractions, roots, accents, matrices, cases,
   aligned equations and theorem-like blocks.
3. Common document structures such as figures, simple tables, footnotes and
   lists with options.
4. Project-specific macros through an explicit, user-reviewable adapter or
   alias mechanism.

Unsupported commands should have a clear compact presentation instead of
looking broken. They should expose their exact source and explain that Rebuild
shows the authoritative result. The adapter registry must fail closed: a
partially understood construct stays source-only instead of being rewritten.

Compiled output can progressively improve the approximate presentation. For
example, after Rebuild Scient may cache measured equation boxes, counters and
resolved references from the exact artifact. These measurements are hints for
the next writing session, not authorization to infer or rewrite source from PDF
geometry.

## 3. Make complex environments easy to insert and type

Users should be able to create constructs such as `bmatrix`, `pmatrix`, `cases`,
`aligned`, `align`, theorem environments and future adapters in several ways:

- type the LaTeX directly, with recognition after the closing delimiter or a
  deliberate conversion command;
- choose an item from an Insert menu or command palette;
- use a contextual math toolbar or slash command;
- paste valid LaTeX and choose whether to keep it as source or convert it to a
  supported structured object.

For a supported matrix, the structured object should offer row/column controls,
keyboard navigation and source access. Its source popover should still expose
the complete environment:

```tex
\begin{bmatrix}
  a & b \\
  c & d
\end{bmatrix}
```

Literal typing must not be destructively transformed before Scient knows that
the whole construct is supported. Recognition should be transactional: parse a
complete candidate, validate its round trip, then replace the source-shaped text
with a structured node while preserving one-step undo. Unsupported or malformed
environments remain ordinary source.

The environment picker should be driven by the same adapter registry as parsing
and serialization. That prevents toolbar options from promising structures the
editor cannot safely save.

## 4. Redesign the editing surface around document work

The visual workspace should combine the familiarity of Docs with the structural
clarity of LyX:

- a calm page or continuous-paper canvas with readable margins and zoom;
- a compact persistent toolbar for text styles, lists and frequent math;
- an Insert menu or command palette for less frequent structures;
- contextual controls near the selected object instead of a crowded global
  toolbar;
- visible but quiet source-only blocks, with a direct route to Source;
- reliable keyboard navigation, selection, copy/paste, undo/redo and IME input;
- clear save, conflict and rebuild states that do not interrupt typing;
- optional structure navigation for headings, labels, figures and equations.

Visual mode should default to semantic structure, not simulated PDF
coordinates. Exact page breaks, floats and final numbering belong to PDF/Split
after Rebuild. The writing surface may use the last build's measurements to
reduce visual movement, but must label stale or approximate presentation
honestly.

The UI should be evaluated with real writing journeys rather than isolated
controls: drafting prose with equations, revising a long section, inserting a
matrix, editing citations, switching to Source for an unsupported macro, and
rebuilding to inspect final output. Screenshots are necessary for layout review;
short recordings are better for popovers, keyboard behavior and conversion.

## Suggested architecture

```text
.tex source (authoritative)
        |
        v
bounded parser + adapter registry
        |
        v
structured editor document  <-->  contextual source popovers
        |
        v
source-preserving serializer + revision-checked save
        |
        +--------------------------> explicit TeX rebuild
                                         |
                                         v
                              exact immutable PDF artifact
                                         |
                                         v
                              PDF/Split verification view
```

The structured editor document is disposable and can always be recreated from
source. Every accepted transaction should identify the exact source range it
owns, preserve unrelated bytes, serialize only supported changes, reparse the
candidate and reject a lossy round trip. External source changes must reset
obsolete editor history rather than replaying undo against a new revision.

Rebuild should remain explicit. A source change marks the previous PDF stale and
offers a reason such as "Rebuild to update macros, references and pagination."
Opening a document, typing, autosaving, changing focus or finishing a toolchain
installation should not silently launch TeX.

## Recommended delivery sequence

Each item needs its own scoped issue and review evidence:

1. Refine math selection and add the complete-source popover, preserving wrapper
   syntax and undo behavior.
2. Introduce the adapter registry and migrate the currently supported commands
   without expanding behavior.
3. Add matrix and cases adapters plus typing, Insert-menu and paste journeys.
4. Redesign the toolbar and contextual controls through a focused UX pass.
5. Add post-rebuild measurements only where they measurably improve continuity,
   without making PDF geometry an editable source model.
6. Expand command coverage in small, tested groups based on real documents.

Before calling the experience exact, compare the writing view and rebuilt PDF
across representative classes, engines, packages, fonts, macros, references,
floats and long documents. Until then, describe the writing view as a fast,
source-derived approximation with exact verification available through Rebuild.
