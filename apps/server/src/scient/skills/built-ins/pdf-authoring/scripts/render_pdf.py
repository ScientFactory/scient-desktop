"""Render selected PDF pages without changing the PDF; output directory must be new."""
import argparse
import json
from pathlib import Path

import pymupdf


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pages", help="Comma-separated 1-based PDF page numbers; default all")
    args = parser.parse_args()
    with pymupdf.open(args.pdf) as document:
        if not document.is_pdf or document.needs_pass:
            parser.error("Use an unlocked PDF.")
        try:
            pages = sorted(set(int(item) for item in args.pages.split(","))) if args.pages else list(range(1, document.page_count + 1))
        except ValueError:
            parser.error("--pages needs comma-separated integers.")
        if not pages or any(page < 1 or page > document.page_count for page in pages):
            parser.error(f"Pages must lie between 1 and {document.page_count}.")
        args.output.mkdir(parents=True, exist_ok=False)
        paths = []
        for number in pages:
            output = args.output / f"page-{number:04d}.png"
            document[number - 1].get_pixmap(dpi=150, alpha=False).save(output)
            paths.append(str(output.resolve()))
        print(json.dumps({"pageCount": document.page_count, "renderedPages": pages, "images": paths}))


if __name__ == "__main__":
    main()
