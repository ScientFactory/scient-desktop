"""Report AcroForm field types, values, and every widget location."""

import json
import sys

from pypdf import PdfReader
from pypdf.generic import DictionaryObject, NullObject

from acroform import choice_options, field_type, on_states, widget_fields


def json_value(value):
    if isinstance(value, (NullObject, DictionaryObject)):
        return None
    if isinstance(value, bytes):
        return value.decode("latin-1")
    if isinstance(value, list):
        return [json_value(item.get_object()) for item in value]
    return value


def get_field_info(reader: PdfReader):
    fields = []
    acro_form = reader.root_object.get("/AcroForm")
    default_appearance = acro_form.get_object().get("/DA") if acro_form is not None else None
    for field_id, widgets in widget_fields(reader.pages).items():
        page, terminal, widget = widgets[0]
        kind = field_type(widget)
        value = terminal.get_inherited("/V")
        field = {
            "field_id": field_id,
            "type": kind,
            "page": page,
            "rect": widget.get("/Rect"),
            "value": json_value(value),
            "flags": widget.get_inherited("/Ff", 0),
            "widgets": [],
        }
        for page_number, _, item in widgets:
            location = {"page": page_number, "rect": item.get("/Rect")}
            if kind in {"checkbox", "radio_group", "pushbutton"}:
                location["on_states"] = on_states(item)
            if kind in {"text", "choice"}:
                location["default_appearance"] = json_value(item.get_inherited("/DA", default_appearance))
            field["widgets"].append(location)
        if kind == "choice":
            field["choice_options"] = [
                {"value": json_value(value), "text": json_value(label)} for value, label in choice_options(widget)
            ]
        if kind == "checkbox":
            states = list(dict.fromkeys(
                state for location in field["widgets"] for state in location["on_states"]
            ))
            field["checked_values"] = states
            field["unchecked_value"] = "/Off"
            if len(states) == 1:
                field["checked_value"] = states[0]
        elif kind == "radio_group":
            field["radio_options"] = [
                {"value": state, "page": location["page"], "rect": location["rect"]}
                for location in field["widgets"] for state in location["on_states"]
            ]
        fields.append(field)

    def sort_key(field):
        rect = field["rect"] or [0, 0, 0, 0]
        return field["page"], -rect[1], rect[0]

    return sorted(fields, key=sort_key)


def write_field_info(pdf_path: str, json_output_path: str):
    field_info = get_field_info(PdfReader(pdf_path))
    with open(json_output_path, "w") as output:
        json.dump(field_info, output, indent=2)
    print(f"Wrote {len(field_info)} fields to {json_output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: extract_form_field_info.py [input pdf] [output json]")
        sys.exit(1)
    write_field_info(sys.argv[1], sys.argv[2])
