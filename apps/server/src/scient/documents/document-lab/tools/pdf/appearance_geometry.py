"""Measure directly painted form glyphs against the appearance's active clips."""

from dataclasses import dataclass, replace
from functools import cached_property
from math import isfinite

from pypdf import Transformation
from pypdf._cmap import get_encoding
from pypdf.generic import ContentStream, DictionaryObject, TextStringObject
from pypdf.generic._font import Font

PATH_SEGMENTS = {b"m", b"l", b"c", b"v", b"y", b"h"}
PATH_ENDS = {b"n", b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*"}
FILL_PATHS = {b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*"}
TEXT_SHOWS = {b"Tj", b"TJ", b"'", b'"'}
TEXT_PARAMS = {b"Tr": "render_mode", b"Tc": "char_space", b"Tw": "word_space",
               b"Tz": "scale", b"Ts": "rise", b"TL": "leading"}
IDENTITY = Transformation()
# Generator positions and common editor coordinates are rounded to 0.001 pt.
TOLERANCE = 0.002


@dataclass(frozen=True)
class ClipRectangle:
    origin: tuple
    across: tuple
    up: tuple

    @classmethod
    def from_rect(cls, x, y, width, height, ctm):
        origin = ctm.apply_on((x, y))
        right = ctm.apply_on((x + width, y))
        top = ctm.apply_on((x, y + height))
        return cls(origin, (right[0] - origin[0], right[1] - origin[1]),
                   (top[0] - origin[0], top[1] - origin[1]))

    @cached_property
    def determinant(self):
        ax, ay = self.across
        ux, uy = self.up
        return ax * uy - ay * ux

    def contains(self, points):
        ax, ay = self.across
        ux, uy = self.up
        det = self.determinant
        if not det:
            return False
        ox, oy = self.origin
        for x, y in points:
            x, y = x - ox, y - oy
            u = (x * uy - y * ux) / det
            v = (ax * y - ay * x) / det
            u_tolerance = TOLERANCE * (abs(ux) + abs(uy)) / abs(det)
            v_tolerance = TOLERANCE * (abs(ax) + abs(ay)) / abs(det)
            if not (-u_tolerance <= u <= 1 + u_tolerance and -v_tolerance <= v <= 1 + v_tolerance):
                return False
        return True


def font_vertical_bounds(font):
    metrics = font.font_descriptor
    return min(metrics.descent, metrics.bbox[1]) / 1000, max(metrics.ascent, metrics.bbox[3]) / 1000


class AppearanceFont:
    def __init__(self, resource):
        self.font = Font.from_font_resource(resource)
        self.encoding, self.to_unicode = get_encoding(resource)
        self.composite = resource.get("/Subtype") == "/Type0"
        if self.composite:
            if resource.get("/Encoding") != "/Identity-H" or not self.to_unicode:
                raise ValueError("cannot measure a composite appearance font without horizontal identity encoding")
        elif resource.get("/Subtype") not in {"/Type1", "/MMType1", "/TrueType"} or not isinstance(self.encoding, dict):
            raise ValueError("cannot measure the appearance font encoding")

    def glyphs(self, operand):
        raw = operand.original_bytes if isinstance(operand, TextStringObject) else bytes(operand)
        if self.composite:
            if len(raw) % 2:
                raise ValueError("appearance text contains an incomplete font code")
            for index in range(0, len(raw), 2):
                code = chr(int.from_bytes(raw[index:index + 2], "big"))
                text = self.to_unicode.get(code)
                if code == "\0" or not text:
                    raise ValueError("appearance text contains an unmapped font code")
                yield text, self.font.get_text_width(code), False
        else:
            for code in raw:
                char = self.encoding.get(code)
                if char in (None, "\0", "\ufffd") or chr(code) not in self.font.character_widths:
                    raise ValueError("appearance text contains an unmapped font code or width")
                yield self.to_unicode.get(char, char), self.font.get_text_width(chr(code)), code == 32

    def vertical_bounds(self, text):
        descent, ascent = font_vertical_bounds(self.font)
        # Standard Helvetica digits and periods have no descenders. Their
        # slight overshoot below the baseline fits Acrobat's numeric boxes.
        if self.font.name == "Helvetica" and all(char in "0123456789." for char in text):
            descent = max(descent, -0.03)
        return descent, ascent


@dataclass
class GraphicsState:
    ctm: Transformation = IDENTITY
    clips: tuple = ()
    font: AppearanceFont | None = None
    size: float = 0
    render_mode: int = 0
    char_space: float = 0
    word_space: float = 0
    scale: float = 100
    rise: float = 0
    leading: float = 0


def check_glyph(state, matrix, text, advance):
    descent, ascent = state.font.vertical_bounds(text)
    if advance < 0 or ascent <= descent:
        raise ValueError("appearance font has unusable glyph metrics")
    transform = matrix.transform(state.ctm)
    corners = [transform.apply_on((x, state.rise + y * state.size))
               for x in (0, advance) for y in (descent, ascent)]
    if not all(isfinite(value) for point in corners for value in point):
        raise ValueError("appearance text has unusable geometry")
    a, b, c, d, _, _ = transform.ctm
    if a * d == b * c:
        raise ValueError("appearance text has a singular transform")
    for clip, name in state.clips:
        if clip is None:
            raise ValueError("cannot verify appearance text under a nonrectangular clip path")
        if not clip.contains(corners):
            raise ValueError(f"appearance text is clipped by the {name}")


def show_text(state, matrix, operands):
    if state.font is None or state.size <= 0 or state.scale <= 0 or state.render_mode not in (0, 1, 2):
        raise ValueError("appearance text is invisible or has no usable font")
    shown = []
    scale = state.scale / 100
    for item in operands:
        if not isinstance(item, (str, bytes)):
            matrix = Transformation().translate(-float(item) * state.size * scale / 1000, 0).transform(matrix)
            continue
        for text, width, is_pdf_space in state.font.glyphs(item):
            advance = width * state.size * scale / 1000
            if not text.isspace():
                check_glyph(state, matrix, text, advance)
            step = advance + scale * (state.char_space + (state.word_space if is_pdf_space else 0))
            matrix = Transformation().translate(step, 0).transform(matrix)
            shown.append(text)
    return "".join(shown), matrix


def appearance_text(appearance, page):
    """Read and measure direct PDF text without relying on /ActualText."""
    resources = appearance.get("/Resources", page.get("/Resources", DictionaryObject())).get_object()
    fonts = resources.get("/Font", DictionaryObject()).get_object()
    font_cache = {}
    x0, y0, x1, y1 = map(float, appearance["/BBox"])
    bounds = ClipRectangle.from_rect(x0, y0, x1 - x0, y1 - y0, IDENTITY)
    state = GraphicsState(clips=((bounds, "widget BBox"),))
    operations = ContentStream(appearance, page.pdf).operations
    marked = []
    saved_states = []
    text_matrix = line_matrix = IDENTITY
    path = []
    clip_pending = highlight = in_text = has_ink = False
    result = []

    def finish_path():
        nonlocal clip_pending
        if clip_pending:
            rect = path[0] if len(path) == 1 else None
            state.clips += ((rect, "clip path"),)
            clip_pending = False
        path.clear()

    for args, op in operations:
        if op in (b"BMC", b"BDC"):
            if args[0] == "/OC":
                raise ValueError("cannot verify optional content in an appearance")
            marked.append(args[0] == "/Tx" or bool(marked and marked[-1]))
        elif op == b"EMC":
            marked.pop()
        elif op == b"q":
            saved_states.append(replace(state))
        elif op == b"Q":
            state = saved_states.pop()
        elif op == b"cm":
            state.ctm = Transformation(tuple(map(float, args))).transform(state.ctm)
        elif op == b"re":
            path.append(ClipRectangle.from_rect(*map(float, args), state.ctm))
        elif op in PATH_SEGMENTS:
            path.append(None)
        elif op in (b"W", b"W*"):
            clip_pending = True
        elif op in PATH_ENDS:
            if has_ink and op in FILL_PATHS:
                raise ValueError("appearance draws a fill over previously painted text")
            if op in (b"s", b"S"):
                # The selected list entry has an outline inside /Tx.
                highlight = bool(marked and marked[-1] and len(path) == 1 and path[0])
            finish_path()
        elif op == b"Tf":
            name, size = args
            if name not in font_cache:
                font_cache[name] = AppearanceFont(fonts[name].get_object())
            state.font, state.size = font_cache[name], float(size)
        elif op in TEXT_PARAMS:
            setattr(state, TEXT_PARAMS[op], float(args[0]))
        elif op == b"BT":
            # Older pypdf used "re W BT" without the explicit path end.
            if clip_pending:
                finish_path()
            if in_text:
                raise ValueError("appearance has a nested text object")
            in_text = True
            line_matrix = text_matrix = IDENTITY
        elif op == b"ET":
            in_text = False
        elif op == b"Tm":
            line_matrix = text_matrix = Transformation(tuple(map(float, args)))
        elif op in {b"Td", b"TD", b"T*", b"'", b'"'}:
            if op in (b"Td", b"TD"):
                dx, dy = map(float, args)
                if op == b"TD":
                    state.leading = -dy
            else:
                dx, dy = 0, -state.leading
            text_matrix = line_matrix = Transformation().translate(dx, dy).transform(line_matrix)
        elif op in {b"Do", b"INLINE IMAGE", b"gs", b"sh", b"SCN", b"scn"}:
            raise ValueError(f"cannot verify visible form text with the {op.decode()} appearance operator")

        if op in TEXT_SHOWS:
            if not in_text or not (marked and marked[-1]):
                raise ValueError("appearance draws text outside a /Tx marked-content group")
            if op == b'"':
                state.word_space, state.char_space = map(float, args[:2])
            shown, text_matrix = show_text(state, text_matrix, args[0] if op == b"TJ" else [args[-1]])
            result.append((shown, highlight))
            has_ink |= bool(shown.strip())
            highlight = False
    if marked or saved_states or in_text or clip_pending:
        raise ValueError("appearance has unbalanced graphics, marked content or text")
    return result
