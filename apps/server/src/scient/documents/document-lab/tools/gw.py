#!/usr/bin/env python3
"""Google Workspace helper arithmetic for the google-workspace skill.

The Scient Google Drive connector exposes raw Google APIs. Models must not do
UTF-16 index math, A1<->grid conversion, or EMU geometry by hand. This CLI
turns saved connector JSON into positions, outlines, and ready batchUpdate
request JSON. Content-addressed: find by text/value, never by counted offsets.

  gw.py docs-outline DOC.json                 headings + paragraph ranges (UTF-16)
  gw.py docs-find DOC.json "exact text"       UTF-16 start/end of each match
  gw.py sheets-grid SHEET_ID_NUMERIC A1RANGE  gridRange JSON (0-based, end exclusive)
  gw.py sheets-format SHEET_ID_NUMERIC A1RANGE [--fg 0000FF] [--bg FFFF00]
                      [--bold] [--number '$#,##0;($#,##0);"-"']   repeatCell request JSON
  gw.py slides-outline PRES.json              per-slide elements in inches + overflow warnings

Save connector results to a file first (get_document / get_presentation /
get_spreadsheet_metadata), then point this at the file. Handles both a raw API
object and {"document": ...} / {"presentation": ...} wrappers.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

EMU_PER_INCH = 914400


def load(p: str, key: str) -> dict:
    def require_object(value):
        if not isinstance(value, dict):
            raise ValueError(f"{key} response must be a JSON object")
        errors = {field: value[field] for field in ("error", "status", "code") if field in value}
        if errors:
            raise ValueError(f"{key} API error response: {json.dumps(errors, ensure_ascii=False)}")
        return value

    data = json.loads(Path(p).read_text(encoding="utf-8"))
    response = require_object(data)
    return require_object(response[key]) if key in response else response


def u16len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


# ---------------------------------------------------------------- Docs
def _doc_segments(doc: dict):
    """Yield (tabId, segmentId, segment) for raw Docs API and Scient-connector shapes.

    Raw API: tabs[].tabProperties.tabId + tabs[].documentTab.{body,headers,...} + childTabs.
    Connector (flattened): tabs[] = {tabId, parentTabId, nestingLevel, body, headers, ...},
    every tab listed at top level, and top-level `body` may be null.
    """
    def segments(tab, tab_id):
        if tab.get("body") is not None:
            yield tab_id, "", tab["body"]
        for kind in ("headers", "footers", "footnotes"):
            for segment_id, segment in (tab.get(kind) or {}).items():
                yield tab_id, segment_id, segment

    def walk(tab):
        if "documentTab" in tab or "tabProperties" in tab:
            tab_id = (tab.get("tabProperties") or {}).get("tabId")
            content = tab.get("documentTab") or {}
        else:
            tab_id, content = tab.get("tabId"), tab
        if not tab_id:
            raise ValueError("tab response is missing its tabId")
        yield from checked_segments(content, tab_id)
        for child in tab.get("childTabs") or []:
            yield from walk(child)

    def checked_segments(tab, tab_id):
        parts = list(segments(tab, tab_id))
        if not parts or any(not isinstance(segment, dict) or not isinstance(segment.get("content"), list)
                            for _, _, segment in parts):
            location = f" for tab {tab_id!r}" if tab_id else ""
            raise ValueError(f"document response is missing content{location}; request body.content or tab content")
        yield from parts

    tabs = doc.get("tabs")
    if tabs is not None and not isinstance(tabs, list):
        raise ValueError("document response requires a tabs array")
    if tabs:
        for tab in tabs:
            yield from walk(tab)
    else:
        yield from checked_segments(doc, None)


def _range(element: dict, kind: str) -> tuple[int, int]:
    start, end = element.get("startIndex"), element.get("endIndex")
    if type(start) is not int or type(end) is not int or not 0 <= start <= end:
        raise ValueError(f"{kind} requires valid startIndex and endIndex from the API")
    return start, end


def _text_spans(paragraph: dict, start: int, end: int):
    """Yield the original UTF-16 offset and text of each contiguous span."""
    span_start = previous_end = start
    runs = []
    for element in paragraph.get("elements") or []:
        if "textRun" not in element:
            if runs:
                yield span_start, "".join(runs)
                runs = []
            continue
        run_start, run_end = _range(element, "textRun")
        content = element["textRun"].get("content")
        if (not isinstance(content, str) or run_end - run_start != u16len(content)
                or not previous_end <= run_start <= run_end <= end):
            raise ValueError("textRun content and API indexes are inconsistent")
        if runs and run_start != previous_end:
            yield span_start, "".join(runs)
            runs = []
        if not runs:
            span_start = run_start
        runs.append(content)
        previous_end = run_end
    if runs:
        yield span_start, "".join(runs)


def docs_paragraphs(doc: dict):
    def visit(content, location):
        for element in content or []:
            if "paragraph" in element:
                start, end = _range(element, "paragraph")
                paragraph = element["paragraph"]
                style = paragraph.get("paragraphStyle", {})
                spans = list(_text_spans(paragraph, start, end))
                yield {
                    **location, "start": start, "end": end,
                    "style": style.get("namedStyleType", "NORMAL_TEXT"),
                    "bullet": bool(style.get("bullet") or paragraph.get("bullet")),
                    "text": "".join(value for _, value in spans).rstrip("\n"),
                }, spans
            elif "table" in element:
                for row in element["table"].get("tableRows") or []:
                    for cell in row.get("tableCells") or []:
                        yield from visit(cell.get("content"), location)
            elif "tableOfContents" in element:
                yield from visit(element["tableOfContents"].get("content"), location)

    for tab_id, segment_id, segment in _doc_segments(doc):
        yield from visit(segment.get("content"), {
            "tab": tab_id, "tabId": tab_id, "segmentId": segment_id,
            "revisionId": doc.get("revisionId"),
        })


def cmd_docs_outline(args) -> int:
    doc = load(args.file, "document")
    rows = [row for row, _ in docs_paragraphs(doc)]
    print(json.dumps({
        "title": doc.get("title"), "revisionId": doc.get("revisionId"),
        "paragraphs": len(rows),
        "headings": [r for r in rows if r["style"].startswith("HEADING") or r["style"] in ("TITLE", "SUBTITLE")],
    }, indent=2, ensure_ascii=False))
    return 0


def cmd_docs_find(args) -> int:
    if not args.text:
        raise ValueError("search text must not be empty")
    doc = load(args.file, "document")
    mode = doc.get("suggestionsViewMode")
    read_only = mode != "SUGGESTIONS_INLINE"
    range_status = {"read_only": read_only}
    if read_only:
        reason = f"suggestionsViewMode is {mode!r}" if mode else "suggestionsViewMode is unknown"
        range_status["reason"] = f"{reason}; read the document with SUGGESTIONS_INLINE for edit ranges"
    hits = []
    match_length = u16len(args.text)
    for row, spans in docs_paragraphs(doc):
        for offset, value in spans:
            pos = value.find(args.text)
            # Measure only new text for each successive match, including overlaps.
            start, measured = offset, 0
            while pos != -1:
                start += u16len(value[measured:pos])
                hits.append({
                    **{k: row[k] for k in ("tab", "tabId", "segmentId", "revisionId", "style")},
                    "start": start, "end": start + match_length,
                    "paragraph_start": row["start"], "paragraph_end": row["end"],
                    "context": row["text"][:160],
                    **range_status,
                })
                measured = pos
                pos = value.find(args.text, pos + 1)
    print(json.dumps({"query": args.text, "revisionId": doc.get("revisionId"),
                      "suggestionsViewMode": mode, **range_status,
                      "matches": len(hits), "hits": hits}, indent=2, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- Sheets
_SHEET_PREFIX = re.compile(r"(?:(?:'((?:[^']|'')+)'|([\w.]+))!)?(.*)")
_A1_ENDPOINT = re.compile(r"(?:\$?([A-Za-z]+))?(?:\$?([1-9][0-9]*))?")


def _a1_endpoint(value: str) -> tuple[int | None, int | None]:
    match = _A1_ENDPOINT.fullmatch(value)
    if not value or not match:
        raise ValueError(f"invalid A1 endpoint: {value!r}")
    letters, row = match.groups()
    column = 0
    for character in (letters or "").upper():
        column = column * 26 + ord(character) - ord("A") + 1
    return (int(row) if row else None, column if letters else None)


def a1_to_grid(sheet_id: int, a1: str, sheet_title: str | None = None) -> dict:
    match = _SHEET_PREFIX.fullmatch(a1)
    if not match or sheet_id < 0:
        raise ValueError(f"invalid sheet ID or A1 range: {sheet_id}, {a1!r}")
    quoted, unquoted, coordinates = match.groups()
    prefix = quoted.replace("''", "'") if quoted is not None else unquoted
    if prefix is not None:
        if sheet_title is None:
            raise ValueError(f"qualified A1 range with sheet {prefix!r} requires --sheet-title")
        if prefix != sheet_title:
            raise ValueError(f"A1 sheet {prefix!r} does not match --sheet-title {sheet_title!r}")
    first, separator, last = coordinates.partition(":")
    starts = _a1_endpoint(first)
    ends = _a1_endpoint(last) if separator else starts
    if not separator and None in starts:
        raise ValueError(f"use a range for whole rows or columns: {a1!r}")
    if not any(start is not None and end is not None for start, end in zip(starts, ends)):
        raise ValueError(f"A1 endpoints have no shared axis: {a1!r}")

    grid = {"sheetId": sheet_id}
    for axis, start, end in zip(("Row", "Column"), starts, ends):
        if start is not None and end is not None and start > end:
            raise ValueError(f"reversed A1 {axis.lower()} bounds: {a1!r}")
        if start is not None:
            grid[f"start{axis}Index"] = start - 1
        if end is not None:
            grid[f"end{axis}Index"] = end
    return grid


def rgb(hexstr: str) -> dict:
    if not re.fullmatch(r"#?[0-9a-fA-F]{6}", hexstr):
        raise ValueError(f"expected six hexadecimal color digits, got {hexstr!r}")
    h = hexstr.removeprefix("#")
    return {"red": int(h[0:2], 16) / 255, "green": int(h[2:4], 16) / 255, "blue": int(h[4:6], 16) / 255}


def cmd_sheets_grid(args) -> int:
    print(json.dumps(a1_to_grid(args.sheet_id, args.range, args.sheet_title), indent=2))
    return 0


def cmd_sheets_format(args) -> int:
    fmt = {}
    text_format = {}
    if args.fg is not None:
        text_format["foregroundColorStyle"] = {"rgbColor": rgb(args.fg)}
    if args.bold:
        text_format["bold"] = True
    if args.font_size is not None:
        if args.font_size <= 0:
            raise ValueError("--font-size must be a positive integer")
        text_format["fontSize"] = args.font_size
    if args.bg is not None:
        fmt["backgroundColorStyle"] = {"rgbColor": rgb(args.bg)}
    if args.number:
        fmt["numberFormat"] = {"type": "NUMBER", "pattern": args.number}
    fields = [f"userEnteredFormat.{field}" for field in fmt]
    if text_format:
        fmt["textFormat"] = text_format
        fields.extend(f"userEnteredFormat.textFormat.{field}" for field in text_format)
    if not fields:
        raise ValueError("give at least one of --fg --bg --bold --font-size --number")
    req = {"repeatCell": {"range": a1_to_grid(args.sheet_id, args.range, args.sheet_title),
                          "cell": {"userEnteredFormat": fmt},
                          "fields": ",".join(fields)}}
    print(json.dumps({"requests": [req]}, indent=2))
    return 0


# ---------------------------------------------------------------- Slides
_UNITS_PER_INCH = {"EMU": EMU_PER_INCH, "PT": 72}
_IDENTITY = (1, 0, 0, 1, 0, 0)


def _number(value) -> float:
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("missing or invalid geometry value")
    return value


def _dimensions(size: dict) -> tuple[float, float]:
    def inches(dimension):
        return _number(dimension.get("magnitude")) / _UNITS_PER_INCH[dimension.get("unit")]

    width, height = (inches(size.get(axis, {})) for axis in ("width", "height"))
    if min(width, height) < 0:
        raise ValueError("negative dimension")
    return width, height


def _transform(value: dict):
    # The API can omit zero-valued terms, including scales for a 90° rotation.
    if not (("scaleX" in value or "shearX" in value) and
            ("scaleY" in value or "shearY" in value)):
        raise ValueError("missing transform axes")
    a, b, c, d, x, y = (_number(value.get(key, 0)) for key in
                       ("scaleX", "shearX", "shearY", "scaleY", "translateX", "translateY"))
    unit = value.get("unit")
    divisor = _UNITS_PER_INCH[unit] if unit is not None or x or y else 1
    return a, b, c, d, x / divisor, y / divisor


def _compose(parent, child):
    a, b, c, d, x, y = parent
    e, f, g, h, u, v = child
    return (a * e + b * g, a * f + b * h, c * e + d * g, c * f + d * h,
            a * u + b * v + x, c * u + d * v + y)


def _bounds(transform, width, height):
    a, b, c, d, x, y = transform
    xs, ys = zip(*((a * u + b * v + x, c * u + d * v + y)
                   for u, v in ((0, 0), (width, 0), (0, height), (width, height))))
    if not all(math.isfinite(value) for value in (*xs, *ys)):
        raise ValueError("non-finite transformed bounds")
    return min(xs), min(ys), max(xs), max(ys)


def _slide_elements(elements, page_size):
    rows, warnings = [], []

    def walk(element, parent, parent_id=None):
        kind = next((k for k in ("elementGroup", "shape", "image", "table", "video",
                                 "line", "wordArt", "sheetsChart") if k in element), "element")
        text = ""
        if kind == "shape":
            text = "".join(e.get("textRun", {}).get("content", "")
                           for e in element[kind].get("text", {}).get("textElements") or [])[:120]
        object_id = element.get("objectId")
        row = {"id": object_id, "kind": kind, "text": text or None}
        if parent_id is not None:
            row["parent_id"] = parent_id
        rows.append(row)

        try:
            transform = _compose(parent, _transform(element.get("transform", {}))) if parent else None
        except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
            transform = None
        bounds = None
        if kind == "elementGroup":
            children = [walk(child, transform, object_id)
                        for child in element[kind].get("children") or []]
            if children and all(child is not None for child in children):
                left, top, right, bottom = zip(*children)
                bounds = min(left), min(top), max(right), max(bottom)
        elif transform is not None:
            try:
                bounds = _bounds(transform, *_dimensions(element.get("size", {})))
            except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
                pass

        row["geometry"] = "known" if bounds is not None else "unknown"
        if bounds is None:
            row.update(x=None, y=None, w=None, h=None, overflow=None)
            warnings.append(f"{object_id} has unknown geometry")
        else:
            x, y, right, bottom = bounds
            row.update(x=round(x, 2), y=round(y, 2),
                       w=round(right - x, 2), h=round(bottom - y, 2))
            if page_size is None:
                row["overflow"] = None
            else:
                page_w, page_h = page_size
                # Allow tiny numerical noise at the edge, without rounding geometry.
                row["overflow"] = min(x, y, page_w - right, page_h - bottom) < -1e-9
                if row["overflow"]:
                    warnings.append(f"{object_id} extends past slide edge "
                                    f"(bounds {x:.2f}, {y:.2f}, {right:.2f}, {bottom:.2f})")
        return bounds

    for element in elements:
        walk(element, _IDENTITY)
    return rows, warnings


def cmd_slides_outline(args) -> int:
    pres = load(args.file, "presentation")
    if not isinstance(pres.get("slides"), list) or not isinstance(pres.get("pageSize"), dict):
        raise ValueError("presentation response requires slides and pageSize content")
    try:
        page_size = _dimensions(pres.get("pageSize", {}))
    except (ValueError, KeyError, TypeError, AttributeError, OverflowError):
        page_size = None
    slides = []
    for i, slide in enumerate(pres["slides"], 1):
        elements, warnings = _slide_elements(slide.get("pageElements") or [], page_size)
        if page_size is None:
            warnings.insert(0, "slide size is unknown")
        slides.append({"slide": i, "id": slide.get("objectId"),
                       "elements": elements, "warnings": warnings})
    print(json.dumps({"title": pres.get("title"),
                      "page_inches": [round(v, 2) for v in page_size] if page_size else [None, None],
                      "revisionId": pres.get("revisionId"), "slides": slides},
                     indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("docs-outline"); p.add_argument("file"); p.set_defaults(fn=cmd_docs_outline)
    p = sub.add_parser("docs-find"); p.add_argument("file"); p.add_argument("text"); p.set_defaults(fn=cmd_docs_find)
    p = sub.add_parser("sheets-grid"); p.add_argument("sheet_id", type=int); p.add_argument("range"); p.set_defaults(fn=cmd_sheets_grid)
    p = sub.add_parser("sheets-format"); p.add_argument("sheet_id", type=int); p.add_argument("range")
    p.add_argument("--fg"); p.add_argument("--bg"); p.add_argument("--bold", action="store_true")
    p.add_argument("--font-size", type=int); p.add_argument("--number"); p.set_defaults(fn=cmd_sheets_format)
    p = sub.add_parser("slides-outline"); p.add_argument("file"); p.set_defaults(fn=cmd_slides_outline)
    for command in ("sheets-grid", "sheets-format"):
        sub.choices[command].add_argument("--sheet-title", help="required for a sheet-qualified A1 range")
    args = ap.parse_args()
    try:
        return args.fn(args)
    except (ValueError, OSError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
