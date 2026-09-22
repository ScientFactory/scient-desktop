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
preference without component changes. The small number of important surfaces
that use fixed pixels or render inside dependency shadow roots consume the
tokens in `apps/web/src/scient/typography/profile.css`:

- workspace file names: 14 px;
- inline chat file links and their tooltips: 14 px;
- compact diff metadata: 13 px; and
- diff and file headers: 14 px.

This is a deliberate product divergence, not a replacement typography system.
Keep receiving T3's appearance architecture normally. Future upstream changes
should preserve the four owned fixed-surface tokens and avoid copying the
profile into individual components.

The profile scales application chrome, rendered chat Markdown, rendered
Markdown file previews, source files, and diffs. It does not alter document
pixels inside images, PDFs, user-authored HTML, or hosted web pages.
