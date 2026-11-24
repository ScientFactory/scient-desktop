"""Add FreeText annotations at boxes measured on a rendered PDF page."""

import argparse
import json
from math import isfinite

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText
from pypdf.errors import PyPdfError
from pypdf.generic import DictionaryObject, NameObject, NumberObject, TextStringObject
from appearance_fonts import choose_font
from appearance_layout import CheckedTextAppearance


def transform_box(box, page, page_info):
    rotation = page.rotation % 360
    x0, y0, x1, y1 = media = tuple(map(float, page.mediabox))
    cx0, cy0, cx1, cy1 = map(float, page.cropbox)
    crop = max(x0, cx0), max(y0, cy0), min(x1, cx1), min(y1, cy1)
    points = "pdf_width" in page_info
    size_keys = ("pdf_width", "pdf_height") if points else ("image_width", "image_height")
    image_width, image_height = (float(page_info.get(key, 0)) for key in size_keys)
    if not points and not (
        isfinite(image_width) and isfinite(image_height) and image_width > 0 and image_height > 0
    ):
        raise ValueError("rendered image must have positive dimensions")

    def size(rect):
        width, height = rect[2] - rect[0], rect[3] - rect[1]
        return (height, width) if rotation in (90, 270) else (width, height)

    def matches_image(rect):
        width, height = size(rect)
        return width > 0 and height > 0 and abs(image_width * height / width - image_height) <= 1.5

    box_name = page_info.get("page_box")
    if box_name is None:
        matches_crop_only = image_width and image_height and matches_image(crop) and not matches_image(media)
        box_name = "cropbox" if matches_crop_only else "mediabox"
    if box_name.lower() == "cropbox":
        x0, y0, x1, y1 = crop
    elif box_name.lower() != "mediabox":
        raise ValueError("page_box must be mediabox or cropbox")

    width, height = size((x0, y0, x1, y1))
    if width <= 0 or height <= 0:
        raise ValueError("rendered page box must have positive dimensions")
    x_scale, y_scale = (1, 1) if points else (width / image_width, height / image_height)

    def to_pdf(x, y):
        x, y = x * x_scale, y * y_scale
        if rotation == 0:
            return x0 + x, y1 - y
        if rotation == 90:
            return x0 + y, y0 + x
        if rotation == 180:
            return x1 - x, y0 + y
        if rotation == 270:
            return x1 - y, y1 - x
        raise ValueError("page rotation must be a multiple of 90 degrees")

    left, top, right, bottom = map(float, box)
    if not (all(map(isfinite, (left, top, right, bottom))) and left < right and top < bottom):
        raise ValueError("entry box must have positive dimensions")
    x, y = to_pdf(left, top)
    other_x, other_y = to_pdf(right, bottom)
    return min(x, other_x), min(y, other_y), max(x, other_x), max(y, other_y)


def attach_rotated_appearance(writer, page, annotation, text, font_name, font_size):
    # The rectangle is in unrotated PDF coordinates. Counter the page's
    # clockwise rotation inside the appearance so text reads horizontally.
    font_name = {
        "Arial": "Helvetica", "Times New Roman": "Times-Roman", "Courier New": "Courier"
    }.get(font_name, font_name)
    widget = DictionaryObject(annotation)
    widget[NameObject("/DA")] = TextStringObject(f"/{font_name} {font_size} Tf {annotation['/DA']}")
    rotation = NumberObject(page.rotation % 360)
    field = DictionaryObject({
        NameObject("/V"): TextStringObject(text),
        NameObject("/MK"): DictionaryObject({NameObject("/R"): rotation}),
    })
    geometry = DictionaryObject({NameObject("/Rotate"): rotation})
    form = DictionaryObject()
    font = choose_font(writer, form, widget, text, None)
    appearance = CheckedTextAppearance.from_text_annotation(
        writer, geometry, False, form, field, widget, user_font_name=font
    )
    annotation[NameObject("/AP")] = DictionaryObject({NameObject("/N"): writer._add_object(appearance)})


def fill_pdf_form(input_pdf_path, fields_json_path, output_pdf_path):
    with open(fields_json_path, encoding="utf-8") as spec:
        fields_data = json.load(spec)
    reader = PdfReader(input_pdf_path)
    writer = PdfWriter()
    writer.append(reader)
    page_specs = {item["page_number"]: item for item in fields_data["pages"]}

    count = 0
    for field in fields_data["form_fields"]:
        entry_text = field.get("entry_text", {})
        if not (text := entry_text.get("text")):
            continue
        page_number = field["page_number"]
        if not 1 <= page_number <= len(writer.pages):
            raise ValueError(f"invalid page number {page_number}")
        page = writer.pages[page_number - 1]
        entry_box = transform_box(field["entry_bounding_box"], page, page_specs[page_number])
        font_name = entry_text.get("font", "Arial")
        font_size = float(entry_text.get("font_size", 14))
        if not isfinite(font_size) or font_size <= 0:
            raise ValueError("annotation font size must be positive")
        annotation = FreeText(
            text=text,
            rect=entry_box,
            font=font_name,
            font_size=f"{font_size:g}pt",
            font_color=entry_text.get("font_color", "000000"),
            border_color=None,
            background_color=None,
        )
        if page.rotation % 360:
            attach_rotated_appearance(writer, page, annotation, text, font_name, font_size)
        writer.add_annotation(page_number=page_number - 1, annotation=annotation)
        count += 1

    writer.write(output_pdf_path)
    print(f"Added {count} text annotations and saved to {output_pdf_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    parser.add_argument("fields")
    parser.add_argument("output")
    args = parser.parse_args()
    try:
        fill_pdf_form(args.input, args.fields, args.output)
    except (OSError, PyPdfError, KeyError, TypeError, ValueError) as error:
        parser.exit(1, f"fill_pdf_form_with_annotations: {error}\n")


if __name__ == "__main__":
    main()
