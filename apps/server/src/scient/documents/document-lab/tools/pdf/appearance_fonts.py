"""Select a font that can paint the requested form text without substitutions."""

from dataclasses import replace
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from unicodedata import category

from pypdf.errors import PdfReadError
from pypdf.generic import DictionaryObject, NameObject
from pypdf.generic._appearance_stream import TextStreamAppearance
from pypdf.generic._font import Font

from appearance_bidi import NONPAINTING, visual_text


def choose_font(writer, form, annotation, text, font_path, direction=None):
    default = annotation.get_inherited("/DA", form.get("/DA"))
    name = TextStreamAppearance._parse_default_appearance(default.get_object())[0] if default else None
    name, font = TextStreamAppearance._find_annotation_font_resource(name or "/Helv", annotation, form, "")
    logical = "".join(char for line in text.splitlines() for char in line if char not in NONPAINTING)
    visual = "".join(visual_text(line, direction) for line in text.splitlines())
    characters = set(logical + visual)
    if any(category(char).startswith("C") for char in characters):
        raise ValueError("form appearance cannot render control characters")
    if font_path is None and font_covers(font, characters):
        return name
    return add_fallback(writer, form, annotation, characters, Path(font_path) if font_path else None)


def font_covers(font, characters):
    try:
        reverse, encoding = font._get_typographic_maps()
    except UnicodeError:
        return False
    return all(
        char in reverse and encoding.get(reverse[char]) not in (None, b"", b"\0", b"\0\0")
        for char in characters
    )


def font_candidates():
    directories = (
        Path("/Library/Fonts"), Path("/System/Library/Fonts"),
        Path.home() / "Library/Fonts", Path("/usr/share/fonts"),
        Path("/usr/local/share/fonts"), Path.home() / ".local/share/fonts",
    )
    fonts = [path for directory in directories for path in directory.rglob("*")
             if path.suffix.lower() in {".ttf", ".ttc", ".otf", ".otc"}]
    return sorted(fonts, key=lambda path: ("arial unicode" not in path.name.lower(), path))


def embedded_font(path, characters):
    try:
        from fontTools import subset
        from fontTools.ttLib import TTFont, TTLibError
    except ImportError as error:
        raise ValueError("embedding a form font requires fonttools") from error

    try:
        with path.open("rb") as file:
            collection = file.read(4) == b"ttcf"
            count = int.from_bytes(file.read(8)[4:], "big") if collection else 1
        for index in range(count):
            with TTFont(path, fontNumber=index, lazy=True, recalcTimestamp=False) as face:
                if "glyf" not in face or "fvar" in face:
                    continue
                cmap = face.getBestCmap() or {}
                if any(cmap.get(ord(char), ".notdef") == ".notdef" for char in characters):
                    continue
                restrictions = face["OS/2"].fsType if "OS/2" in face else 0
                if restrictions & 0x0302 or (restrictions & 0x0004 and not restrictions & 0x0008):
                    continue  # This font must allow editable, subsetted embedding.
                subsetter = subset.Subsetter()
                # Keep common characters for subsequent edits in a PDF viewer.
                subsetter.populate(unicodes={ord(char) for char in characters} | set(range(32, 127)))
                subsetter.subset(face)
                data = BytesIO()
                face.save(data)
                font = Font.from_truetype_font_file(data)
                if font_covers(font, characters):
                    # Distinct subsets need distinct PDF font names so a
                    # viewer cannot reuse another subset's glyph indices.
                    digest = sha256(data.getbuffer()).digest()
                    prefix = "".join(chr(ord("A") + byte % 26) for byte in digest[:6])
                    postscript_name = face["name"].getDebugName(6) or font.name.replace(" ", "")
                    name = f"{prefix}+{postscript_name}"
                    return replace(font, name=name, font_descriptor=replace(font.font_descriptor, name=name))
    except (OSError, PdfReadError, TTLibError):
        return None
    return None


def add_fallback(writer, form, annotation, characters, font_path):
    candidates = [font_path] if font_path is not None else font_candidates()
    for path in candidates:
        font = embedded_font(path, characters)
        if font is None:
            continue
        form_resources = form.setdefault(NameObject("/DR"), DictionaryObject()).get_object()
        form_fonts = form_resources.setdefault(NameObject("/Font"), DictionaryObject()).get_object()
        local = annotation.get_inherited("/DR", form_resources).get_object()
        local_fonts = DictionaryObject(local.get("/Font", DictionaryObject()).get_object())
        index = 1
        while (name := NameObject(f"/LabFont{index}")) in form_fonts or name in local_fonts:
            index += 1
        font._add_to_writer(writer, form_fonts, name)
        local_fonts[name] = form_fonts.raw_get(name)
        annotation[NameObject("/DR")] = DictionaryObject(local)
        annotation["/DR"][NameObject("/Font")] = local_fonts
        return str(name)
    detail = f"{font_path} is not an embeddable TrueType font covering this value" if font_path else (
        "no installed embeddable TrueType font covers this value; pass --font PATH"
    )
    raise ValueError(detail)
