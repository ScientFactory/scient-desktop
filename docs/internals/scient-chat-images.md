# Scient inline workspace images

Status: implemented as the static scientific-image layer beneath future
artifact-backed and interactive renderers.

## Contract and ownership

A settled Markdown image whose destination resolves to a supported file inside
the current workspace is presented by a Scient-owned image card. Ordinary
remote images and unsupported destinations retain React Markdown's inherited
image behavior. The host integration is one `img` renderer in
`ChatMarkdown.tsx`; resolution, presentation, actions, and tests live under
`apps/web/src/scient/images`.

The source Markdown and project file remain canonical. The card derives a
rooted `workspace-file` resource from `cwd + relativePath`, retaining the
thread/path locator only for server-version compatibility. Signed URLs are
renewable renderer state and never become image identity. Opening the source
routes through the existing file surface.

This layer deliberately uses the existing workspace-image allowlist instead of
inventing a PNG/SVG-only contract. PNG and SVG are the primary scientific
representations, while JPEG, WebP, GIF, AVIF, and ICO follow the same browser
image path.

## Lifecycle and presentation

Workspace resolution begins only after the message settles. The card owns
loading, loaded, one automatic URL-renewal retry, recoverable failure, manual
refresh, and action feedback states. Native lazy image decoding avoids eagerly
decoding offscreen figures. The expanded surface reuses the existing static
image zoom implementation and preserves its zoom across signed-URL renewal.
One shared action menu keeps original download, PNG clipboard copy,
relative-path copy, background inspection, and refresh available in both
compact and expanded views; the expanded header also retains source-file
opening.

The card downloads the original bytes. Clipboard copy uses PNG because it is
the reliable Chromium clipboard interchange format; non-PNG inputs are
rasterized on demand with bounded dimensions and pixels. SVG remains vector for
display and download. Automatic, light, and dark backgrounds let transparent
figures remain inspectable without altering their bytes.

SVG is always loaded through an `img` element and the asset server's existing
SVG response policy. No SVG source enters `dangerouslySetInnerHTML`, an iframe,
or the document runtime. A truly interactive SVG belongs to an HTML/browser or
semantic chart representation, not this static image surface.

## Relationship to scientific artifacts

This is a representation surface, not a second artifact store. A future
artifact-to-chat adapter can supply a generated-document or analysis-artifact
resource to the same presentation shell while retaining artifact identity,
revision, provenance, and retention in their owning packages. Plotly and
Vega-Lite remain semantic interactive representations; SVG and PNG are their
portable static companions.

## Platform boundary

Desktop and web use this card because their chat renderer can request renewable
workspace-asset URLs from the conversation's environment. The Markdown remains
portable: older clients retain the source and alt text, while a dedicated
mobile workspace-resource adapter can adopt the same representation later
without changing the chat protocol or image files.

## Verification

Focused tests cover workspace/path resolution, every accepted extension,
outside-workspace rejection, rooted asset descriptors, Markdown preservation,
copy bounds, background cycling, the server-rendered card contract, provider
awareness, and the single inherited Markdown seam. The manual fixture covers
SVG, PNG, encoded spaces, missing files, light/dark backgrounds, expansion,
zoom, copy, download, refresh, and source opening.
