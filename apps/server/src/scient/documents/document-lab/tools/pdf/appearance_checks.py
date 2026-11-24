"""Check stored form text against the value it is meant to display."""

import re
from decimal import Decimal

from pypdf.constants import AnnotationFlag
from pypdf.generic import DictionaryObject, NullObject

from acroform import (
    Ff,
    appearance_state,
    can_omit_missing_appearance,
    choice_options,
    field_type,
    normal_appearance,
    normal_appearances,
    on_states,
)
from appearance_bidi import extracted_glyphs, field_direction, visual_text
from appearance_geometry import appearance_text


def number_display(widget, value):
    """Recognize the simple Acrobat numeric format used in the AO440 form."""
    actions = widget.get_inherited("/AA", DictionaryObject()).get_object()
    action = actions.get("/F", DictionaryObject()).get_object()
    if action.get("/S") != "/JavaScript":
        return None
    script = action.get("/JS", "").get_object() if "/JS" in action else ""
    match = re.fullmatch(r'\s*AFNumber_Format\(\s*([0-9])\s*,\s*0\s*,\s*0\s*,\s*0\s*,\s*""\s*,\s*true\s*\);?\s*', str(script))
    if match and re.fullmatch(r"-?[0-9]{1,20}(?:\.[0-9]{1,20})?", value):
        return format(Decimal(value), f",.{match[1]}f")
    return None


def _actual_texts(appearance):
    """Every /ActualText in BDC property lists, read from the parsed content stream.

    Parsing (not byte regex) resolves equivalent PDF names such as /Actual#54ext and
    string encodings (hex, literal, UTF-16BE/UTF-8 BOM) the way viewers do.
    """
    from pypdf.generic import ContentStream, DictionaryObject, NameObject

    stream = appearance.get_object() if hasattr(appearance, "get_object") else appearance
    if not hasattr(stream, "get_data"):
        return []
    resources = stream.get("/Resources")
    properties = {}
    if resources is not None:
        properties = resources.get_object().get("/Properties", DictionaryObject()).get_object()
    texts = []
    for operands, operator in ContentStream(stream, None).operations:
        if operator != b"BDC" or len(operands) < 2:
            continue
        props = operands[1]
        if isinstance(props, NameObject):  # named property list in /Resources /Properties
            props = properties.get(props)
        props = props.get_object() if props is not None and hasattr(props, "get_object") else props
        if isinstance(props, DictionaryObject) and "/ActualText" in props:
            value = props["/ActualText"]
            texts.append(value if isinstance(value, str) else str(value))
    return texts


def verify_actual_text(appearance, label, *also_allowed):
    """/ActualText is what extraction returns; it must carry the logical value, not a stale one."""
    allowed = {label, *label.splitlines(), *(text for text in also_allowed if text)}
    stale = [text for text in _actual_texts(appearance) if text not in allowed]
    if stale:
        raise ValueError(f"appearance /ActualText disagrees with the field value: {stale[:3]!r}")


def verify_variable_appearance(widget, appearance, page):
    kind = field_type(widget)
    if kind not in {"text", "choice"}:
        return
    flags = widget.get_inherited("/Ff", 0)
    value = widget.get_inherited("/V")
    if value is None or isinstance(value, NullObject):
        value = ""
    options = dict(choice_options(widget)) if kind == "choice" else {}

    shown_items = appearance_text(appearance, page)
    shown = [extracted_glyphs(text) for text, _ in shown_items]
    direction = field_direction(widget)

    def display(text):
        return extracted_glyphs(visual_text(text, direction))

    if kind == "choice" and not flags & Ff.Combo:
        selection = value if isinstance(value, list) else [value] if value else []
        selected_labels = [display(options.get(item, item)) for item in selection]
        marked = [text for text, (_, selected) in zip(shown, shown_items) if selected]
        labels = {display(label) for label in options.values()}
        if marked != selected_labels or any(label not in labels for label in shown):
            raise ValueError("choice appearance does not verify the selected value")
        return
    if not isinstance(value, str):
        raise ValueError("cannot verify a non-string field value")
    label = options.get(value, value)
    expected = [display(line) for line in label.splitlines()]
    if flags & Ff.Comb:
        matches = "".join(shown) == "".join(expected)
    elif flags & Ff.Multiline:
        matches = " ".join(" ".join(shown).split()) == " ".join(" ".join(expected).split())
    else:
        matches = (shown or [""]) == (expected or [""])
    if not matches and kind == "text" and len(shown) == 1:
        matches = shown[0] == number_display(widget, value)
    if not matches:
        raise ValueError("stored appearance text disagrees with the field value")
    verify_actual_text(appearance, label, number_display(widget, value))


def checked_appearance(widget, page, buttons):
    kind = field_type(widget)
    if kind in {"checkbox", "radio_group"}:
        verify_button(widget, buttons, kind)
    appearance = normal_appearance(widget)
    if appearance is None:
        flags = int(widget.get("/F", 0))
        if flags & (AnnotationFlag.HIDDEN | AnnotationFlag.NO_VIEW) or can_omit_missing_appearance(widget):
            return None
        raise ValueError("widget has no usable /AP /N for visible content")
    if appearance.get("/Subtype") != "/Form":
        raise ValueError("widget normal appearance is not a Form XObject")
    verify_variable_appearance(widget, appearance, page)
    return appearance


def verify_button(widget, buttons, kind):
    value = widget.get_inherited("/V")
    if value in (None, "") or isinstance(value, NullObject):
        value = "/Off"
    normal = normal_appearances(widget)
    state = appearance_state(widget, normal)
    available = value in on_states(widget)
    flags = widget.get_inherited("/Ff", 0)
    shared = kind == "radio_group" and not flags & Ff.RadiosInUnison
    if state != (value if available else "/Off") and not (shared and available and state == "/Off"):
        raise ValueError("stored button appearance state disagrees with the field value")
    if value != "/Off":
        terminal = widget["/Parent"] if "/Parent" in widget and not widget.get("/T") else widget
        buttons.setdefault((id(terminal), value, shared), []).append(state == value)


def verify_button_selections(buttons):
    for (_, _, shared), selected in buttons.items():
        if not any(selected) or (shared and sum(selected) != 1):
            raise ValueError("stored button appearances do not show the field selection")
