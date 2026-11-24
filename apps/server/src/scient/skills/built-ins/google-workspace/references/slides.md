# Google Slides – read this before any deck read intended for editing, any deck write, or deck creation. Follow the operation and destination steps in SKILL.md. Charts on slides: read `charts.md` too.

## Geometry and image replacement

- Read the units on page size, element size and transform translations.
  Magnitudes can use PT or EMU (12,700 EMU per point). Use the units declared
  in each outgoing request.
- Save structured presentation JSON and run `"$PY" "$GW" slides-outline pres.json`.
  It normalizes the units and computes bounds from transformed corners,
  composing group transforms with their children's transforms. Use the
  bounds to check placement and overflow. Verify object IDs and the original
  transform in structured data before writing. Bounds alone cannot recover
  the rotation, shear, reflection or group-relative transform.
- Prefer `replaceImage` on the existing image object ID. Choose the replacement
  method for the intended fit and verify the crop. If recreation is necessary,
  record the old crop, affine transform, group placement, and z-order.
  Creating a replacement and deleting the original does not preserve layering.
  Restore the intended stacking explicitly and inspect all these properties
  in the read-back and render.

## Masked, bounded reads

- A full `get_presentation` payload for a media-heavy deck is enormous. Prefer,
  in order: `get_presentation_outline` (slide IDs + titles for targeting),
  `get_presentation_text` (content questions), `get_slide` (one slide's full
  detail), `get_presentation_tables` (table contents). Pull the full object
  only when you need element geometry – and then immediately reduce it with
  `slides-outline`.
- Where the connector accepts a fields mask on reads, request only the branches
  you'll use. Where it doesn't, save the JSON to a file and query the file –
  don't paste the raw payload through your context repeatedly.
- Target slides by **object ID** from the outline, not by "slide 5": inserting
  or deleting a slide renumbers everything after it, IDs don't move.

## Text fit and scope

- Text and other fit-affecting API edits can deactivate autofit. Check the
  text box bounds and adjust wording, size, or placement within the brief.
  Inspect the changed slide thumbnail for overflow and neighbour overlap.
- Slides `replaceAllText` scopes by `pageObjectIds`. Preflight matches on the
  selected slides. For one shape or table cell, use object-scoped text
  requests such as `deleteText` and `insertText` with the verified object ID
  and, for a cell, its `cellLocation`. Reuse the existing element and check
  the affected text styles.

## Image input

- Use a URL Google can fetch server-side at insertion time. For local or
  generated images, check the connector's `image_uris` sidecar and map its
  workspace image paths to request placeholders as described in SKILL.md.
  If neither path is available, identify the missing capability. Local
  build and import require the requested output to authorize a new deck.
- Size new images for the available space and preserve their aspect ratio.
  Read back the new object and inspect the crop, edges, and neighbours.

## Creating a new deck: two routes

For an authorized new deck, choose a route.

1. **Build locally, import** – for figure-heavy, precisely laid-out, or
   chart-heavy decks. Build the `.pptx` with the `powerpoint-pptx` skill
   (images embedded as files, exact geometry), then
   `google_drive.import_presentation` with native conversion. Verify per the
   checklist: fonts substitute, some effects flatten, embedded charts may
   arrive as pictures (rebuild as linked Sheets charts if they must stay live –
   `charts.md`).
2. **Native template copy** – when the user has a house template deck in Drive.
   `google_drive.create_presentation_from_template` (or `copy_file` on the
   template), then edit the copy's placeholders in place: real title/body
   placeholders inherit the template's design system, which no amount of API
   shape-drawing reproduces. Rename the copy via `update_file` immediately so
   it isn't mistaken for the template.

- Starting from `create_file` (blank native deck) and drawing every shape via
  API is the last resort: slow, and the result looks like API defaults. Use it
  only for trivially simple decks.
- Whichever route: the deck the user receives is the imported/copied file.
  Link it, and say which route produced it.

## Editing an existing deck

- Follow the template already in the deck: duplicate an existing slide whose
  layout fits (`duplicateObject` on the slide) and edit its placeholders,
  rather than inserting a blank slide with a stock layout that clashes.
- Speaker notes: read/write the notes page's text shape via the slide's
  `notesPage` – target it by its placeholder, and don't confuse it with an
  on-slide text box that merely contains similar words.
- Deleting slides/elements: `deleteObject` by ID, one logical change per batch
  (SKILL.md), with `requiredRevisionId` set. Re-read the outline afterwards –
  slide order and count are part of the deliverable.
- Tables on slides: read via `get_presentation_tables`; write cell text by
  targeting the table cell's text, not by deleting/recreating the table
  (recreation loses the deck's table styling).

## Verify checklist (Slides)

- [ ] `slides-outline` on the fresh revision: no "extends past slide edge"
      warnings on changed slides; element count per changed slide as intended.
- [ ] `get_slide_thumbnail` viewed for **every changed slide**: text fits its
      boxes, images aren't stretched (aspect preserved), nothing overlaps,
      colours/fonts match neighbouring slides.
- [ ] For whole-deck deliverables: `export_file` to PDF, render, flip through
      all pages – title consistency, no leftover placeholder text
      ("Click to add title"), no orphaned template slides at the end.
- [ ] Read back changed text (`get_presentation_text`): new wording present
      once, no duplicated slide content from a copy-edit slip.
- [ ] Report links the verified deck ID and lists changed slide numbers and titles. State "visual inspection not performed" if
      thumbnails/export were unavailable.
