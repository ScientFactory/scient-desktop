# Fill a PDF form

Read when filling or classifying a PDF form. Run the commands from the workspace, with paths to a working copy and new output.

## Check both representations

Inspect `PdfReader.get_fields()` and walk each page’s `/Annots`. Dereference the annotations, filter `/Subtype /Widget` and follow `/Parent` for inherited field names, types and values. Compare the page widgets with the field tree's `/Kids` and the visible labels. A field can lack a visible widget and a page widget can be missing from the field tree. A printed box alone is insufficient evidence of a widget.

```sh
"$PY" "$TOOLS/pdf/check_fillable_fields.py" form.pdf
"$PY" "$TOOLS/pdf/extract_form_field_info.py" form.pdf field-info.json
```

The first helper checks the field tree. The second walks the page widgets and groups them by qualified field ID. Its `widgets` array gives every one-based page and rectangle. The top-level page and rectangle identify the first widget. The extractor resolves `/FT`, `/Ff`, `/V`, `/DA` and `/Opt` through the parent chain as applicable. Button types come from `/Ff`. Each button widget lists its on-states, even when a checkbox group uses a different state per widget. Compare the widget inventory with the field tree. Investigate discrepancies with pypdf before editing. For encrypted forms, follow [the protected-PDF reference](protected-pdfs.md). Use the flat-form route when both representations are absent and the page has printed entry areas.

Done when the field or annotation route is supported by the file and the visible labels resolve the inputs.

## Fill existing fields

Use a JSON array containing `field_id`, one-based `page`, and string `value`. For a repeated field, give any reported widget page and a single shared value. The helper updates all widgets for that field. When radio widgets share an on-state and select individually, give a page that identifies one matching widget. Use an on-state for a button selection, `/Off` where clearing is allowed, and the export value for a choice list. Paired choices retain that export value in `/V` and use the display label in the appearance.

```json
[
  { "field_id": "operator", "page": 1, "value": "Ada Example" },
  { "field_id": "confirmed", "page": 1, "value": "/Yes" }
]
```

```sh
"$PY" "$TOOLS/pdf/fill_fillable_fields.py" form.pdf values.json filled.pdf
"$PY" "$TOOLS/pdf/check_fillable_fields.py" filled.pdf
"$PY" "$TOOLS/pdf/extract_form_field_info.py" filled.pdf filled-field-info.json
"$PY" "$DOC" render filled.pdf --out NEW_DIR
```

The helper reopens the staged PDF and checks the saved values and the text or button state in the normal appearances it rebuilt. A partial fill generally preserves the source's `/NeedAppearances` setting, which asks the viewer to regenerate appearances. If a fill needs the stored layout for non-ASCII text or an explicit font, the helper repairs stale text appearances and checks the full form before clearing that setting.

When the source font lacks a glyph, the helper searches installed fonts for embeddable TrueType outlines. Pass `--font PATH` to select an explicit font for text and choices. The lab fallback uses `fonttools`. FriBidi lays out each Hebrew, Arabic or mixed-direction paragraph, using direction marks or field rich-text direction when supplied and first-strong direction by default. The field’s `/Q` controls left, center or right alignment. For multiline bidi text, supply explicit line breaks or use automatic sizing. The appearance stores the logical string as `/ActualText` and keeps the original `/V` in the interactive copy. Extractors can ignore the replacement or reorder it for display. If their output differs, check the saved logical string and the painted order separately. Use a different font or a form editor that supports the script if coverage or shaping fails. Open every filled page image to check alignment, legibility and visible ticks. Keep fields interactive unless flattening is expressly requested. If a form relies on PDF viewer JavaScript, record whether those calculations ran.

Done when persisted values, interactive state and the visible entries agree with the request.

## Flatten filled widgets

Use this route when the user requests a fixed copy. The helper checks text painted inside the `/Tx` group against the effective field value and checks its measured bounds against the widget’s appearance box and rectangular clips. It also checks button states. To repair stale or clipped text, pass the saved `/V` back through the fill helper. For a value that needs smaller text, add `--font-size auto` to the fill command. Reopen and inspect the working copy before flattening. Use a form editor for appearances whose font or other graphics the helper cannot verify.

```sh
"$PY" "$TOOLS/pdf/flatten_form.py" filled.pdf flattened.pdf
"$PY" "$DOC" validate flattened.pdf
"$PY" "$DOC" render flattened.pdf --out NEW_DIR
```

The helper paints screen-visible widget appearances into page content, removes all widget annotations and removes the catalog’s `/AcroForm`. It paints existing normal appearances for blank and off widgets too, including their visible borders and backgrounds. A blank or off widget with no normal appearance and no visible content can be removed on its own. If an absent appearance would erase a value or decoration, the helper exits nonzero. Regenerate that appearance with a form editor and check the rendered working copy before retrying. The helper preserves other page annotations. Hidden and print-only widgets are excluded from the painted content. Use an XFA-capable tool for XFA forms. For a signed input, preserve the signed original and identify the new copy as a derivative. Keep protected copies under the authorized workflow in [the protected-PDF reference](protected-pdfs.md).

Done when reopening finds zero widget annotations and no AcroForm field tree, retained non-widget annotations still work, and comparison with the filled render confirms values, ticks, borders and backgrounds. Render both at the same DPI and compare pixels when flattening is meant to keep the pages visually identical.

## Annotate a flat form

Use the structure extractor for text-based labels, lines and boxes. For a scan, locate them on the render. Build an annotation spec with a `pages` array (one-based `page_number`, `image_width`, `image_height`) and a `form_fields` array (one-based `page_number`, `description`, `label_bounding_box`, `entry_bounding_box`, `entry_text: {"text":"…"}`). Use top-left-origin pixel coordinates in `[left, top, right, bottom]` measured on the rendered image after page rotation. Set `"page_box": "cropbox"` on each page when you measure from the lab’s `doc.py render` output. It renders the CropBox. Use `"page_box": "mediabox"` for images rendered from the full MediaBox. A CropBox can have the same proportions as the MediaBox, so specify the box explicitly.

```json
{
  "pages": [{ "page_number": 1, "image_width": 600, "image_height": 840, "page_box": "cropbox" }],
  "form_fields": [
    {
      "page_number": 1,
      "description": "Name",
      "label_bounding_box": [20, 35, 170, 65],
      "entry_bounding_box": [196, 173, 511, 218],
      "entry_text": { "text": "Ada Example" }
    }
  ]
}
```

```sh
"$PY" "$TOOLS/pdf/extract_form_structure.py" form.pdf structure.json
"$PY" "$TOOLS/pdf/check_bounding_boxes.py" annotation-spec.json
"$PY" "$TOOLS/pdf/create_validation_image.py" 1 annotation-spec.json render/page-1.png overlay-1.png
"$PY" "$TOOLS/pdf/fill_pdf_form_with_annotations.py" form.pdf annotation-spec.json filled.pdf
```

Read the box check’s messages, since a reported failure may still exit zero. Look at the overlays before filling and render the filled copy afterward. Reopen and verify the new annotations and their locations.

Done when all entries appear beside the intended labels and the output can be reopened.
