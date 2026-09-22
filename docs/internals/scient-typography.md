# Scient typography profile

Scient uses T3's existing appearance settings and font application pipeline.
The product reading defaults are 17 px interface text,
16 px prompt text, 15 px code and file-source text, and 14 px terminal text.
Users can still change every existing appearance preference; persisted choices
remain authoritative.

Interface text weight offers Light (300), Regular (400, the existing default),
and Medium (500). It applies to ordinary interface and conversation text; the
prompt inherits it in both simple and advanced typography modes. Explicit
medium, semibold, bold, and Markdown emphasis retain their existing styling.
Monospace code, file/diff bodies, and the canvas terminal keep their own weights.
The preference is client-local, independent of light/dark palettes, and resets
with the Interface font row or Restore Defaults. Available font faces determine
how closely each requested weight can be rendered.

Most of the interface uses `rem` units and therefore follows the interface
preference. Shared reading sizes live in
`apps/web/src/scient/typography/profile.css`. Rendered chat Markdown and editable
Markdown documents share body (0.905rem), heading (1.28/1.155/1.03rem), and
table/inline-code (0.78rem) sizes. H4–H6 use the body size. These add 0.03rem to
the previous content scale. Existing specialized footnote sizes remain distinct:
0.78rem in chat, 0.85rem in the document editor.

The conversation timeline, panel launcher and tab names, and selected file-viewer
chrome opt into `scient-reading-ui`: 0.9rem body and 0.775rem secondary text,
an increase of 0.025rem. These are local overrides of the existing utilities;
nested scopes do not compound. Small file notices use 0.675rem. Utility line
heights retain their existing rem dimensions; prose keeps its line-height ratio.
Other panel contents, global menus, sidebar, and settings keep their own scale.

Shadow-root and fixed-pixel exceptions also consume this profile:

- workspace file names: 0.85rem (14.45 px at the default Interface size);
- inline file links and their tooltips: 14 px, with the local reading increment
  applied to links inside the timeline or rendered Markdown;
- compact diff metadata: 13 px; and
- diff and file headers: 14 px.

This is a deliberate product divergence, not a replacement typography system.
Keep receiving T3's appearance architecture normally. Future upstream changes
should preserve the shared reading and surface tokens and avoid copying their
values into individual components.

Prompt, source-file/diff, and terminal sizes retain their separate preferences.
Chat code blocks use Code size; the editable Markdown editor currently retains
its existing 0.8rem code-block size. The reading profile does not alter document
pixels inside images, PDFs, user-authored HTML, or hosted web pages.
