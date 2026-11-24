"""Fill AcroForm fields and verify the saved values and normal appearances."""

import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from pypdf import PdfReader, PdfWriter
from pypdf.errors import PyPdfError
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NullObject,
    NumberObject,
    TextStringObject,
)
from appearance_checks import checked_appearance, verify_button_selections, verify_variable_appearance
from appearance_bidi import field_direction
from appearance_fonts import choose_font
from appearance_layout import checked_appearance_class
from acroform import (
    Ff,
    can_omit_missing_appearance,
    choice_options,
    field_type,
    normal_appearance,
    normal_appearances,
    on_states,
    page_widgets,
    widget_fields,
)


def text_appearance(writer, page, form, widget, kind, value, font_path, auto_font_size=False):
    # Use effective field attributes for rendering without copying inherited
    # entries onto the saved form or changing the source choice options.
    field = DictionaryObject()
    for key in ("/FT", "/Ff", "/Q", "/MK", "/BS"):
        inherited = widget.get_inherited(key, form.get(key) if key == "/Q" else None)
        if inherited is not None:
            field[NameObject(key)] = inherited
    annotation = DictionaryObject(widget)
    old_normal = normal_appearances(widget)
    annotation.pop("/AP", None)
    flags = field.get("/Ff", 0)
    if flags & Ff.Comb and (length := widget.get_inherited("/MaxLen")) is not None:
        if kind == "text" and len(value) > length:
            raise ValueError("value exceeds the comb field's /MaxLen")
        annotation[NameObject("/MaxLen")] = length
    displayed_text = value
    if kind == "choice":
        options = dict(choice_options(widget))
        annotation[NameObject("/Opt")] = ArrayObject(TextStringObject(label) for label in options.values())
        value = options.get(value, value)
        displayed_text = value
        if not flags & Ff.Combo:
            value = ArrayObject([TextStringObject(value)]) if value else ArrayObject()
            displayed_text = "\n".join(options.values())
    field[NameObject("/V")] = value if isinstance(value, ArrayObject) else TextStringObject(value)
    direction = field_direction(widget)
    appearance_class = checked_appearance_class(direction)
    if auto_font_size:
        default = annotation.get_inherited("/DA", form.get("/DA"))
        name, _, color = appearance_class._parse_default_appearance(default.get_object()) if default else (None, 0, None)
        annotation[NameObject("/DA")] = TextStringObject(
            f"{name or '/Helv'} 0 Tf {color.as_operator() if color else '0 g'}"
        )
    font_name = choose_font(writer, form, annotation, displayed_text, font_path, direction)
    appearance = appearance_class.from_text_annotation(
        writer, page, False, form, field, annotation, user_font_name=font_name
    )
    if "/DA" in annotation:
        widget[NameObject("/DA")] = annotation["/DA"]
    if old_normal is not None and "/Matrix" in old_normal:
        appearance[NameObject("/Matrix")] = old_normal["/Matrix"]
    appearances = DictionaryObject(widget["/AP"]) if "/AP" in widget else DictionaryObject()
    appearances[NameObject("/N")] = writer._add_object(appearance)
    widget[NameObject("/AP")] = appearances
    return font_path is not None or not displayed_text.isascii()


def fill_button(writer, widget, state):
    widget[NameObject("/AS")] = state
    appearance = normal_appearance(widget)
    if appearance is None and state == "/Off" and can_omit_missing_appearance(widget):
        # Some forms only store on-states. Save an explicit transparent off
        # appearance when the widget has no visible off-state decoration.
        appearance = DecodedStreamObject()
        appearance.set_data(b"")
        appearance[NameObject("/Type")] = NameObject("/XObject")
        appearance[NameObject("/Subtype")] = NameObject("/Form")
        appearance[NameObject("/BBox")] = ArrayObject(NumberObject(i) for i in (0, 0, 1, 1))
        appearances = DictionaryObject(widget["/AP"]) if "/AP" in widget else DictionaryObject()
        normal = DictionaryObject(normal_appearances(widget) or {})
        normal[state] = writer._add_object(appearance)
        appearances[NameObject("/N")] = normal
        widget[NameObject("/AP")] = appearances
    if appearance is None:
        raise ValueError(f"cannot render button state {state}")


def fill_field(writer, form, widgets, page_number, value, font_path, auto_font_size):
    terminal = widgets[0][1]
    kind = field_type(widgets[0][2])
    if any(field is not terminal or field_type(widget) != kind for _, field, widget in widgets):
        raise ValueError("ambiguous field name or inconsistent widget types")
    if not isinstance(value, str):
        raise ValueError("use a string value")

    if kind in {"checkbox", "radio_group"}:
        selected = [index for index, (_, _, widget) in enumerate(widgets) if value in on_states(widget)]
        if value != "/Off" and not selected:
            raise ValueError(f"unknown button state {value!r}")
        flags = widgets[0][2].get_inherited("/Ff", 0)
        if kind == "radio_group" and flags & Ff.NoToggleToOff and value == "/Off":
            raise ValueError("this radio field requires a selected option")
        if kind == "radio_group" and not flags & Ff.RadiosInUnison and len(selected) > 1:
            selected = [index for index in selected if widgets[index][0] == page_number]
            if len(selected) != 1:
                raise ValueError("radio state is shared by multiple widgets, choose an unambiguous page")
        stored_value = NameObject(value)
    elif kind in {"text", "choice"}:
        if kind == "choice" and any(value not in dict(choice_options(widget)) for _, _, widget in widgets):
            raise ValueError(f"unknown choice export value {value!r}")
        stored_value = TextStringObject(value)
        selected = []
    else:
        raise ValueError(f"filling {kind} fields is unsupported")

    terminal[NameObject("/V")] = stored_value
    if kind == "choice":
        terminal.pop("/I", None)
    states = []
    requires_stored_appearance = False
    for index, (page, _, widget) in enumerate(widgets):
        if widget is not terminal:
            widget.pop("/V", None)
        if kind in {"checkbox", "radio_group"}:
            state = stored_value if index in selected else NameObject("/Off")
            fill_button(writer, widget, state)
        else:
            requires_stored_appearance |= text_appearance(
                writer, writer.pages[page - 1], form, widget, kind, value, font_path, auto_font_size
            )
            state = None
        states.append(state)
    return stored_value, states, requires_stored_appearance


def verify_fields(saved, expected):
    fields = widget_fields(saved.pages)
    for field_id, (value, states, _) in expected.items():
        widgets = fields.get(field_id, [])
        if len(widgets) != len(states):
            raise ValueError(f"{field_id}: reopened output has a different number of widgets")
        for (page_number, terminal, widget), state in zip(widgets, states):
            appearance = normal_appearance(widget)
            if (
                terminal.get("/V") != value
                or widget.get_inherited("/V") != value
                or (state is not None and widget.get("/AS") != state)
                or appearance is None
                or appearance.get("/Subtype") != "/Form"
            ):
                raise ValueError(f"{field_id}: reopened field value or normal appearance does not match")
            try:
                verify_variable_appearance(widget, appearance, saved.pages[page_number - 1])
            except ValueError as error:
                raise ValueError(f"{field_id}: {error}") from error


def repair_variable_appearance(writer, form, page, widget):
    kind = field_type(widget)
    value = widget.get_inherited("/V")
    if value is None or isinstance(value, NullObject):
        value = ""
    if kind == "choice" and isinstance(value, list) and len(value) == 1:
        value = value[0]
    if kind not in {"text", "choice"} or not isinstance(value, str):
        raise ValueError("this widget needs regeneration in a form editor")
    # The source field value and its inheritance are authoritative. Repair
    # only the appearance of an untouched field, without replacing its /V.
    text_appearance(writer, page, form, widget, kind, value, None)


def check_form_appearances(document, repair_form=None):
    buttons = {}
    for page_number, page in enumerate(document.pages, 1):
        for index, widget in enumerate(page_widgets(page), 1):
            try:
                try:
                    checked_appearance(widget, page, buttons)
                except ValueError:
                    if repair_form is None or field_type(widget) not in {"text", "choice"}:
                        raise
                    repair_variable_appearance(document, repair_form, page, widget)
                    checked_appearance(widget, page, buttons)
            except (IndexError, KeyError, TypeError, ValueError) as error:
                raise ValueError(f"page {page_number}, widget {index}: {error}") from error
    verify_button_selections(buttons)


def fill_pdf_fields(input_pdf_path, fields_json_path, output_pdf_path, font_path=None, auto_font_size=False):
    source, output = Path(input_pdf_path), Path(output_pdf_path)
    if source.resolve() == output.resolve() or (output.exists() and source.samefile(output)):
        raise ValueError("choose a separate output PDF")
    requests = json.loads(Path(fields_json_path).read_text())
    reader = PdfReader(source)
    if reader.is_encrypted:
        raise ValueError("use an authorized decrypted working copy, then restore output protection")
    writer = PdfWriter(clone_from=reader)
    form = writer.root_object.get("/AcroForm")
    if form is None:
        raise ValueError("no AcroForm")
    form = form.get_object()
    if "/XFA" in form:
        raise ValueError("use an XFA-capable tool for XFA forms")
    fields = widget_fields(writer.pages)

    expected = {}
    for request in requests:
        field_id, page = request["field_id"], request["page"]
        widgets = fields.get(field_id)
        if not widgets:
            raise ValueError(f"{field_id}: unknown field ID")
        if page not in {page_number for page_number, _, _ in widgets}:
            raise ValueError(f"{field_id}: no widget on page {page}")
        if "value" not in request:
            continue
        if field_id in expected:
            if expected[field_id][0] != request["value"]:
                raise ValueError(f"{field_id}: conflicting values for a shared field")
            continue
        try:
            expected[field_id] = fill_field(writer, form, widgets, page, request["value"], font_path, auto_font_size)
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{field_id}: {error}") from error
    # A partial update cannot take away the viewer's instruction to
    # regenerate appearances for the widgets we did not rebuild.
    total_widgets = sum(1 for page in writer.pages for _ in page_widgets(page))
    full_update = expected and sum(len(states) for _, states, _ in expected.values()) == total_widgets
    needs_regeneration = form["/NeedAppearances"].value if "/NeedAppearances" in form else False
    verify_all = needs_regeneration and any(
        requires_stored for _, _, requires_stored in expected.values()
    )
    if verify_all:
        # A viewer may re-render even the widgets we just built when the
        # form requests regeneration, losing their bidi layout. Clear the
        # flag only after checking every saved appearance.
        check_form_appearances(writer, repair_form=form)
    if full_update or verify_all:
        writer.set_need_appearances_writer(False)

    with TemporaryDirectory(dir=output.parent, prefix=".fill-form-") as temp:
        staged = Path(temp) / "filled.pdf"
        writer.write(staged)
        with staged.open("rb") as saved:
            reopened = PdfReader(saved)
            verify_fields(reopened, expected)
            if verify_all:
                check_form_appearances(reopened)
        staged.replace(output)
    print(f"Reopened {output}: verified saved values and normal appearances for {len(expected)} fields")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input")
    parser.add_argument("values")
    parser.add_argument("output")
    parser.add_argument("--font", type=Path, help="embed an explicit TrueType font for text and choices")
    parser.add_argument("--font-size", choices=["auto"], help="fit requested text within its field")
    args = parser.parse_args()
    try:
        fill_pdf_fields(args.input, args.values, args.output, args.font, args.font_size == "auto")
    except (OSError, PyPdfError, KeyError, TypeError, ValueError) as error:
        parser.exit(1, f"fill_fillable_fields: {error}\n")


if __name__ == "__main__":
    main()
