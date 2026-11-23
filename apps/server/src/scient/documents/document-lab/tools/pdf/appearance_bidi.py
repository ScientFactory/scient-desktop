"""Resolve form paragraphs for PDF rendering while keeping the logical value."""

import ctypes
import re
import unicodedata
from ctypes.util import find_library
from functools import lru_cache
from xml.etree.ElementTree import ParseError

from defusedxml.ElementTree import fromstring
from defusedxml.common import DefusedXmlException

# Unicode Bidi_Control, plus shaping and algorithm placeholders.
BIDI_CONTROLS = frozenset("\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")
NONPAINTING = BIDI_CONTROLS | frozenset("\u200c\u200d\ufeff")
PARAGRAPH_DIRECTIONS = {None: 0x40, "ltr": 0x110, "rtl": 0x111}  # FriBidiParType


def style_direction(style):
    matches = re.findall(r"(?:^|;)\s*direction\s*:\s*(rtl|ltr)\s*(?=;|$)", str(style), re.I)
    return matches[-1].lower() if matches else None


def field_direction(widget):
    # AcroForm /Q is quadding. Direction can be supplied by rich-text
    # defaults or an XHTML body or sole paragraph wrapping the field value.
    rich = widget.get_inherited("/RV")
    if rich:
        if hasattr(rich, "get_data"):
            rich = rich.get_data()
        try:
            root = fromstring(rich)
        except (ParseError, DefusedXmlException, TypeError, ValueError):
            root = None
        while root is not None and root.tag.rsplit("}", 1)[-1] in ("html", "body", "p", "div"):
            direction = style_direction(root.get("style", "")) or root.get("dir", "").lower()
            if direction in ("ltr", "rtl"):
                return direction
            root = root[0] if len(root) == 1 and not (root.text or "").strip() else None
    return style_direction(widget.get_inherited("/DS", ""))


def needs_bidi(text, direction):
    return direction == "rtl" or any(
        char in NONPAINTING or unicodedata.bidirectional(char) in {"R", "AL", "AN"}
        for char in text
    )


@lru_cache(maxsize=1)
def fribidi_layout():
    candidates = (
        find_library("fribidi"),
        "/opt/homebrew/opt/fribidi/lib/libfribidi.dylib",
        "/usr/local/opt/fribidi/lib/libfribidi.dylib",
    )
    for candidate in filter(None, candidates):
        try:
            library = ctypes.CDLL(candidate)
        except OSError:
            continue
        layout = library.fribidi_log2vis
        chars = ctypes.POINTER(ctypes.c_uint32)
        indices = ctypes.POINTER(ctypes.c_int)
        levels = ctypes.POINTER(ctypes.c_int8)
        layout.argtypes = [chars, ctypes.c_int, chars, chars, indices, indices, levels]
        layout.restype = ctypes.c_int8
        return layout
    raise ValueError("bidirectional form appearances require the FriBidi shared library")


def extracted_glyphs(text):
    # ToUnicode maps Arabic presentation glyphs to their underlying letters,
    # including the two-letter sequence for a lam-alef glyph.
    return "".join(
        unicodedata.normalize("NFKC", char)
        if "\ufb50" <= char <= "\ufdff" or "\ufe70" <= char <= "\ufefc" else char
        for char in text
    )


@lru_cache(maxsize=32)
def visual_text(text, direction=None):
    if not text or not needs_bidi(text, direction):
        return text
    if any(unicodedata.category(char).startswith("M") for char in text):
        raise ValueError("RTL combining marks require glyph positioning unsupported by this helper")
    # Use the complete paragraph algorithm, including bracket pairing,
    # mirroring, and Arabic joining. A zero-width placeholder from an Arabic
    # ligature carries no glyph. /ActualText retains the original sequence.
    chars = ctypes.c_uint32 * len(text)
    base = ctypes.c_uint32(PARAGRAPH_DIRECTIONS[direction])
    output = chars()
    if not fribidi_layout()(chars(*map(ord, text)), len(text), ctypes.byref(base), output, None, None, None):
        raise ValueError("could not resolve bidirectional form paragraph")
    return "".join(char for char in map(chr, output) if char not in NONPAINTING)
