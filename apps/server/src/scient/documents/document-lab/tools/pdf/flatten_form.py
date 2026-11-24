"""Paint stored AcroForm widget appearances and remove the interactive form."""

import argparse
import math
from pathlib import Path
from tempfile import TemporaryDirectory

from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.constants import AnnotationFlag
from pypdf.errors import PyPdfError
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
)

from appearance_checks import checked_appearance, verify_button_selections


def placement(widget, appearance):
    """Fit the transformed appearance bounding box to the widget rectangle."""
    left, bottom, right, top = map(float, widget["/Rect"])
    x0, y0, x1, y1 = map(float, appearance["/BBox"])
    values = appearance["/Matrix"] if "/Matrix" in appearance else (1, 0, 0, 1, 0, 0)
    matrix = Transformation(tuple(map(float, values)))
    corners = [matrix.apply_on((x, y)) for x in (x0, x1) for y in (y0, y1)]
    xs, ys = zip(*corners)
    width, height = max(xs) - min(xs), max(ys) - min(ys)
    if not width or not height:
        raise ValueError("widget appearance has an empty bounding box")
    scale_x = abs(right - left) / width
    scale_y = abs(top - bottom) / height
    transform = (
        scale_x, 0, 0, scale_y,
        min(left, right) - scale_x * min(xs),
        min(bottom, top) - scale_y * min(ys),
    )
    if not scale_x or not scale_y or not all(map(math.isfinite, transform)):
        raise ValueError("widget has unusable appearance geometry")
    return " ".join(f"{value:.12f}".rstrip("0").rstrip(".") for value in transform)


def flatten_page(writer, page, page_number, buttons):
    annotations = page.get("/Annots", ArrayObject()).get_object()
    retained = ArrayObject()
    drawings = []
    widget_count = 0
    for index, reference in enumerate(annotations, 1):
        annotation = reference.get_object()
        if annotation.get("/Subtype") != "/Widget":
            retained.append(reference)
            continue
        widget_count += 1
        flags = int(annotation.get("/F", 0))
        try:
            appearance = checked_appearance(annotation, page, buttons)
            if appearance is not None and not flags & (AnnotationFlag.HIDDEN | AnnotationFlag.NO_VIEW):
                drawings.append((appearance, placement(annotation, appearance)))
        except (IndexError, KeyError, TypeError, ValueError) as error:
            raise ValueError(f"page {page_number}, widget annotation {index}: {error}") from error

    if drawings:
        # Page resource dictionaries and content streams can be shared.
        resources = DictionaryObject(page.get("/Resources", DictionaryObject()).get_object())
        xobjects = DictionaryObject(resources.get("/XObject", DictionaryObject()).get_object())
        appearance_commands = []
        next_name = 1
        for appearance, transform in drawings:
            while NameObject(f"/FlattenedWidget{next_name}") in xobjects:
                next_name += 1
            name = NameObject(f"/FlattenedWidget{next_name}")
            next_name += 1
            ref = getattr(appearance, "indirect_reference", None)
            if ref is None:
                ref = writer._add_object(appearance)
            xobjects[name] = ref
            appearance_commands.append(f"q {transform} cm {name} Do Q\n")
        resources[NameObject("/XObject")] = xobjects
        page[NameObject("/Resources")] = resources
        old_content = page.get_contents()
        original = b"" if old_content is None else b"q\n" + old_content.get_data() + b"\nQ\n"
        stream = DecodedStreamObject()
        stream.set_data(original + "".join(appearance_commands).encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)

    if widget_count:
        if retained:
            page[NameObject("/Annots")] = retained
        else:
            del page["/Annots"]
    return widget_count, len(drawings), annotation_signatures(retained)


def annotation_signatures(references):
    return tuple(
        (ref.get_object().get("/Subtype"), getattr(ref, "idnum", None),
         getattr(ref, "generation", None))
        for ref in references
    )


def flatten_form(source: Path, output: Path):
    if source.resolve() == output.resolve() or (output.exists() and source.samefile(output)):
        raise ValueError("choose a separate output PDF")
    reader = PdfReader(source)
    if reader.is_encrypted:
        raise ValueError("use an authorized decrypted working copy, then restore output protection")
    if "/AcroForm" in reader.root_object and "/XFA" in reader.root_object["/AcroForm"]:
        raise ValueError("use an XFA-capable tool for XFA forms")

    writer = PdfWriter(clone_from=reader)
    buttons = {}
    results = [
        flatten_page(writer, page, index, buttons)
        for index, page in enumerate(writer.pages, 1)
    ]
    verify_button_selections(buttons)
    writer.root_object.pop("/AcroForm", None)

    with TemporaryDirectory(dir=output.parent, prefix=".flatten-form-") as temp:
        staged_path = Path(temp) / "flattened.pdf"
        writer.write(staged_path)
        with staged_path.open("rb") as staged:
            saved = PdfReader(staged)
            if "/AcroForm" in saved.root_object or saved.get_fields():
                raise ValueError("reopened output still has an AcroForm field tree")
            if len(saved.pages) != len(results):
                raise ValueError("reopened output has a different page count")
            for page, (_, _, expected) in zip(saved.pages, results):
                annotations = page.get("/Annots", ArrayObject()).get_object()
                if annotation_signatures(annotations) != expected:
                    raise ValueError("reopened output has widgets or changed other annotations")
        staged_path.replace(output)

    removed = sum(count for count, _, _ in results)
    painted = sum(count for _, count, _ in results)
    print(f"Reopened {output}: painted {painted} appearances and removed {removed} widgets")
    print("AcroForm absent. Other page annotation types and counts preserved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        flatten_form(args.input, args.output)
    except (OSError, PyPdfError, ValueError) as error:
        parser.exit(1, f"flatten_form: {error}\n")


if __name__ == "__main__":
    main()
