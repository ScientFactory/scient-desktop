"""Generate variable-text appearances with measured text and logical replacement text."""

from math import floor

from pypdf.generic._appearance_stream import TextAlignment, TextStreamAppearance, WidthWordGlyphs

from appearance_bidi import needs_bidi, visual_text
from appearance_geometry import font_vertical_bounds


class CheckedTextAppearance(TextStreamAppearance):
    direction = None

    @staticmethod
    def _find_annotation_font_resource(font_name, annotation, form, text):
        # choose_font has checked the exact glyphs this layout will display.
        return TextStreamAppearance._find_annotation_font_resource(font_name, annotation, form, "")

    def _generate_appearance_stream_data(
        self, text, selection, font, font_name, font_size, font_color,
        is_multiline, alignment, is_comb, max_length,
    ):
        rectangle = self._layout.rectangle
        margin = self._layout.border_width * (2 if self._layout.border_style in {"/B", "/I"} else 1)
        inset = max(margin, 1) * 2
        width = rectangle.width - 2 * inset
        height = rectangle.height - 2 * margin
        if width <= 0 or height <= 0:
            raise ValueError("field has no usable text area")

        reverse, encoding = font._get_typographic_maps()
        descent, ascent = font_vertical_bounds(font)
        leading = ascent - descent
        if leading <= 0:
            raise ValueError("form font has no usable line height")
        cell_width = rectangle.width / max_length if is_comb and max_length else None

        def line(logical, display):
            glyphs = "".join(reverse[char] for char in display)
            return WidthWordGlyphs(font.get_text_width(glyphs) / 1000, logical, glyphs)

        # Reorder complete bidi paragraphs. Keep explicit lines for bidi text
        # so automatic wrapping does not resolve each fragment independently.
        paragraphs = text.splitlines()
        bidirectional = any(needs_bidi(value, self.direction) for value in paragraphs)
        if cell_width:
            lines = [line(char, char) for char in visual_text(text, self.direction)]
        else:
            lines = [line(value, visual_text(value, self.direction)) for value in paragraphs]

        if font_size == 0:
            maximum = float("inf")
            if is_multiline and not bidirectional and not selection and not cell_width:
                words = [[line(word, word) for word in value.split(" ")] for value in paragraphs]
                wrapped, maximum = self._scale_text(font, 12, leading, width, height, words, 4)
                lines = [WidthWordGlyphs(font.get_text_width(item.glyphs) / 1000, item.word, item.glyphs)
                         for item in wrapped]
            widest = max((item.width for item in lines), default=0)
            fit_width = min(width, cell_width - 2 * margin) if cell_width else width
            number_of_rows = 1 if cell_width else max(len(lines), 1)
            size = min(maximum, height / (leading * number_of_rows), fit_width / (widest or 1))
            font_size = floor(size * 1000) / 1000
            if font_size <= 0:
                raise ValueError("value cannot fit at an automatic font size")

        def actual_text(logical):
            utf16 = (b"\xfe\xff" + logical.encode("utf-16-be")).hex()
            return f"/Span << /ActualText <{utf16}> >> BDC\n"

        clip_inset = 0 if cell_width else inset
        clip_width = rectangle.width - 2 * clip_inset
        commands = [f"q\n/Tx BMC\nq\n{clip_inset} {margin} {clip_width:.6f} {height:.6f} re W n\n"]
        if cell_width and bidirectional:
            commands.append(actual_text(text))

        multiple_rows = not cell_width and (is_multiline or len(lines) > 1)
        baseline = (rectangle.height - (ascent + descent) * font_size) / 2
        if multiple_rows:
            baseline = rectangle.height - margin - ascent * font_size
        for index, (advance, logical, glyphs) in enumerate(lines):
            span = advance * font_size
            x = inset
            if cell_width:
                x = index * cell_width + (cell_width - span) / 2
            elif alignment == TextAlignment.RIGHT:
                x = rectangle.width - inset - span
            elif alignment == TextAlignment.CENTER:
                x = (rectangle.width - span) / 2
            y = baseline - (index * font_size * leading if multiple_rows else 0)

            if selection and logical in selection:
                commands.append(
                    f"1 {y + descent * font_size:.6f} {rectangle.width - 2} "
                    f"{(ascent - descent) * font_size:.6f} re 0.5 G s\n"
                )
            commands.append(
                f"BT\n{font_name} {font_size} Tf {font_color.as_operator()}\n"
                f"1 0 0 1 {x:.6f} {y:.6f} Tm\n"
            )
            replacement = not cell_width and needs_bidi(logical, self.direction)
            if replacement:
                commands.append(actual_text(logical))
            commands.append(f"<{b''.join(encoding[glyph] for glyph in glyphs).hex()}> Tj\n")
            if replacement:
                commands.append("EMC\n")
            commands.append("ET\n")
        if cell_width and bidirectional:
            commands.append("EMC\n")
        commands.append("Q\nEMC\nQ\n")
        return "".join(commands).encode("ascii")


def checked_appearance_class(direction):
    # The inherited annotation factory constructs the appearance immediately.
    # Bind the field direction to that call without changing global state.
    class DirectedTextAppearance(CheckedTextAppearance):
        pass

    DirectedTextAppearance.direction = direction
    return DirectedTextAppearance
