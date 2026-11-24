"""Shared AcroForm field and widget lookups."""

from collections import defaultdict

from pypdf.constants import FieldDictionaryAttributes
from pypdf.generic import DictionaryObject, NullObject, StreamObject

Ff = FieldDictionaryAttributes.FfBits


def page_widgets(page):
    for reference in page["/Annots"] if "/Annots" in page else ():
        widget = reference.get_object()
        if widget.get("/Subtype") == "/Widget":
            yield widget


def widget_fields(pages):
    """Group page widgets by qualified field name, retaining their terminal field."""
    fields = defaultdict(list)
    for page_number, page in enumerate(pages, 1):
        for widget in page_widgets(page):
            names = []
            terminal = widget
            if not widget.get("/T") and "/Parent" in widget:
                terminal = widget["/Parent"]
            current = widget
            seen = set()
            while current is not None:
                if id(current) in seen:
                    raise ValueError("cycle in widget /Parent chain")
                seen.add(id(current))
                if name := current.get("/T"):
                    names.append(name)
                current = current["/Parent"] if "/Parent" in current else None
            if names:
                field_id = ".".join(reversed(names))
                fields[field_id].append((page_number, terminal, widget))
    return fields


def field_type(widget):
    kind = widget.get_inherited("/FT")
    if kind == "/Btn":
        flags = widget.get_inherited("/Ff", 0)
        if flags & Ff.Pushbutton:
            return "pushbutton"
        if flags & Ff.Radio:
            return "radio_group"
        return "checkbox"
    return {"/Tx": "text", "/Ch": "choice", "/Sig": "signature"}.get(kind, f"unknown ({kind})")


def choice_options(widget):
    for option in widget.get_inherited("/Opt", []):
        option = option.get_object()
        yield tuple(item.get_object() for item in option) if isinstance(option, list) else (option, option)


def normal_appearances(widget):
    if "/AP" not in widget:
        return None
    appearances = widget["/AP"]
    if not isinstance(appearances, DictionaryObject) or isinstance(appearances, StreamObject):
        raise ValueError("widget has an invalid /AP dictionary")
    normal = appearances["/N"] if "/N" in appearances else None
    if normal is not None and not isinstance(normal, DictionaryObject):
        raise ValueError("widget has an invalid /AP /N")
    return normal


def on_states(widget):
    normal = normal_appearances(widget)
    if normal is None or isinstance(normal, StreamObject):
        return []
    return [key for key in normal if key != "/Off" and isinstance(normal[key], StreamObject)]


def appearance_state(widget, normal):
    state = widget.get("/AS")
    if state is not None:
        return state
    value = widget.get_inherited("/V")
    if value in (None, "", "/Off") or isinstance(value, NullObject):
        return "/Off"
    if isinstance(normal, DictionaryObject) and isinstance(value, str) and value in normal:
        return value
    return None


def normal_appearance(widget):
    normal = normal_appearances(widget)
    if isinstance(normal, StreamObject):
        return normal
    state = appearance_state(widget, normal)
    if normal is not None and state in normal:
        appearance = normal[state]
        if not isinstance(appearance, StreamObject):
            raise ValueError("widget has an invalid normal appearance for its state")
        return appearance
    return None


def can_omit_missing_appearance(widget):
    """Allow an absent appearance only when there is no value or decoration to paint."""
    kind = field_type(widget)
    off = kind in {"checkbox", "radio_group"} and appearance_state(
        widget, normal_appearances(widget)
    ) == "/Off"
    value = widget.get_inherited("/V")
    if kind in {"checkbox", "radio_group"}:
        if not off:
            return False
    elif value not in (None, "", []) and not isinstance(value, NullObject):
        return False

    if kind == "choice" and not widget.get_inherited("/Ff", 0) & Ff.Combo:
        if widget.get_inherited("/Opt", []):
            return False

    mk = widget.get_inherited("/MK")
    if mk is not None:
        if any(mk.get(key) for key in ("/BC", "/BG", "/I", "/RI", "/IX")):
            return False
        # A checkbox/radio caption is its on-state glyph. Pushbutton captions
        # and icons are visible content even when the field has no /V.
        if not off and any(mk.get(key) for key in ("/CA", "/RC", "/AC")):
            return False
    border = widget.get_inherited("/Border")
    style = widget.get_inherited("/BS")
    if (border is not None and border[2] > 0) or (
        mk is None and style is not None and style.get("/W", 1) > 0
    ):
        return False
    return not (widget.get("/C") or widget.get_inherited("/RV"))
