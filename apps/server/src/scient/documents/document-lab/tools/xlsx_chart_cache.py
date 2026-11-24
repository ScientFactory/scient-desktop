#!/usr/bin/env python3
"""Check Excel chart reachability and classic series caches.

Run doc.py recalc on the edited workbook first. This tool compares saved
worksheet results and writes cache updates directly to a separate package.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import posixpath
import re
import shutil
import tempfile
import zipfile
from bisect import bisect_right
from collections import Counter
from copy import copy
from dataclasses import dataclass
from datetime import timedelta
from hashlib import file_digest, sha256
from pathlib import Path
from urllib.parse import urlsplit
from xml.etree.ElementTree import TreeBuilder, tostring
from xml.parsers import expat
from xml.sax.saxutils import escape

from openpyxl.utils.cell import coordinate_to_tuple, get_column_letter, range_boundaries
from openpyxl.utils.datetime import MAC_EPOCH, WINDOWS_EPOCH, from_ISO8601, to_excel

from doc import (
    CONTENT_TYPES_NS, OFFICE_REL_NAMESPACES, RELS_NS, SPREADSHEET_NAMESPACES,
    _internal_target, _part_key, _read_package_xml, _zip_members,
)

CHART_NAMESPACES = (
    "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "http://purl.oclc.org/ooxml/drawingml/chart",
)
CHART_EXT_NS = "http://schemas.microsoft.com/office/drawing/2014/chartex"
CHART_EXT_REL = "http://schemas.microsoft.com/office/2014/relationships/chartEx"
CHART_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
CHART_EXT_TYPE = "application/vnd.ms-office.chartex+xml"
DRAWING_TYPE = "application/vnd.openxmlformats-officedocument.drawing+xml"
# Content types are compared case-insensitively (RFC 2045); real workbooks declare
# "sharedStrings" / "calcChain" in camelCase.
MUTABLE_PART_TYPES = {f"application/vnd.openxmlformats-officedocument.spreadsheetml.{kind}+xml"
                      for kind in ("worksheet", "sharedstrings", "calcchain")}
DOCUMENT_PROPERTIES = {"docprops/app.xml", "docprops/core.xml"}
MODIFIED_DATE = "{http://purl.org/dc/terms/}modified"
SHA256_HEX = re.compile(r"[a-f0-9]{64}")
SERIES_FIELDS = {"val", "cat", "tx", "xVal", "yVal", "bubbleSize"}
CHART_REFS = {f"{{{ns}}}chart" for ns in CHART_NAMESPACES}
LOCAL_REFERENCE = re.compile(r"(?P<sheet>'(?:[^']|'')+'|[^',!()]+)!(?P<area>.+)", re.S)
CELL_RANGE = re.compile(r"\$?[A-Za-z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Za-z]{1,3}\$?[1-9][0-9]*)?")
TAG = re.compile(rb"""<(?:[^<>"']|"[^"]*"|'[^']*')*>""")
ATTRIBUTE = re.compile(rb"""\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')""")
MISSING_FORMULA_CACHE = object()


def qualified(namespace, local):
    return f"{{{namespace}}}{local}"


def relationship_id(element):
    for namespace in OFFICE_REL_NAMESPACES:
        rid = element.get(qualified(namespace, "id"))
        if rid:
            return rid
    return None


class Package:
    def __init__(self, archive):
        self.archive = archive
        self.members = _zip_members(archive)
        self.relationships = {}
        manifest = self.xml("[content_types].xml")
        ns = f"{{{CONTENT_TYPES_NS}}}"
        if manifest.tag != ns + "Types":
            raise ValueError("invalid content type manifest")
        self.overrides = {}
        self.defaults = {}
        for node in manifest:
            if node.tag == ns + "Override":
                key = _part_key(node.attrib["PartName"].lstrip("/"))
                types = self.overrides
            elif node.tag == ns + "Default":
                key = node.attrib["Extension"].casefold()
                types = self.defaults
            else:
                continue
            if key in types:
                raise ValueError(f"duplicate content type registration for {key!r}")
            types[key] = node.attrib["ContentType"]

    def xml(self, part):
        return _read_package_xml(self.archive, self.members[part])

    def rels(self, part):
        if part in self.relationships:
            return self.relationships[part]
        folder, name = posixpath.split(part)
        rel_part = posixpath.join(folder, "_rels", name + ".rels")
        relationships = {}
        if rel_part in self.members:
            root = self.xml(rel_part)
            ns = f"{{{RELS_NS}}}"
            if root.tag != ns + "Relationships":
                raise ValueError(f"{rel_part}: invalid relationships root")
            for rel in root:
                rid = rel.attrib["Id"]
                if rel.tag != ns + "Relationship" or rid in relationships:
                    raise ValueError(f"{rel_part}: invalid or duplicate relationship {rid!r}")
                relationships[rid] = rel
        self.relationships[part] = relationships
        return relationships

    @staticmethod
    def kind(relation):
        rel_type = relation.attrib["Type"]
        if rel_type == CHART_EXT_REL:
            return "chartEx"
        namespace, _, local = rel_type.rpartition("/")
        return local if namespace in OFFICE_REL_NAMESPACES else None

    def resolve(self, part, rid, expected):
        rel = self.rels(part).get(rid)
        if rel is None:
            raise ValueError(f"{part}: unmatched {expected} relationship r:id {rid!r}")
        if self.kind(rel) != expected:
            raise ValueError(f"{part} {rid}: expected a {expected} relationship")
        target = rel.attrib["Target"]
        if rel.get("TargetMode", "Internal") != "Internal":
            raise ValueError(f"{part} {rid}: non-internal {expected} target {target!r}")
        if urlsplit(target).fragment:
            raise ValueError(f"{part} {rid}: unexpected fragment in {expected} target {target!r}")
        resolved = _internal_target(target, part)
        if resolved not in self.members:
            raise ValueError(f"{part} {rid}: missing target {target!r}")
        return resolved

    def related(self, part, kind):
        return [rid for rid, rel in self.rels(part).items() if self.kind(rel) == kind]

    def content_type(self, part):
        return self.overrides.get(part, self.defaults.get(part.rpartition(".")[2]))

    def registered(self, *types):
        return {part for part in self.members.keys() | self.overrides.keys()
                if self.content_type(part) in types}


def cell_text(element, ns):
    if element is None:
        return ""
    return "".join(node.text or "" for node in
                   [*element.findall(ns + "t"), *element.findall(f"{ns}r/{ns}t")])


class Workbook:
    def __init__(self, package, report, baseline):
        self.package = package
        self.sheets = {}
        self.charts = {}
        self.reachable_charts = {}
        self.drawings = set()
        self.cells = {}
        self.shared_strings = None
        self.report = report
        self.baseline = baseline
        workbook_ids = package.related("", "officeDocument")
        if len(workbook_ids) != 1:
            raise ValueError("expected exactly one officeDocument relationship")
        self.part = package.resolve("", workbook_ids[0], "officeDocument")
        root = package.xml(self.part)
        self.ns = root.tag.removesuffix("workbook")
        if self.ns not in {f"{{{n}}}" for n in SPREADSHEET_NAMESPACES}:
            raise ValueError("officeDocument target is not a supported workbook")
        properties = root.find(self.ns + "workbookPr")
        self.epoch = (MAC_EPOCH if properties is not None
                      and properties.get("date1904") in {"1", "true"} else WINDOWS_EPOCH)
        sheets = root.find(self.ns + "sheets")
        if sheets is None:
            raise ValueError("workbook is missing its sheets list")
        for sheet in sheets.findall(self.ns + "sheet"):
            name = sheet.attrib["name"]
            try:
                self.inspect_sheet(name, relationship_id(sheet))
            except (ValueError, KeyError) as exc:
                self.error(str(exc), sheet=name)
        for drawing in sorted(package.registered(DRAWING_TYPE) - self.drawings):
            self.error("registered drawing is unreachable from workbook sheets", drawing=drawing)
        registered = package.registered(CHART_TYPE, CHART_EXT_TYPE)
        for chart in sorted(registered - self.reachable_charts.keys()):
            self.error("registered chart is unreachable from workbook sheets", chart=chart)

    def error(self, message, **location):
        self.report["errors"].append({**location, "reason": message})

    def inspect_sheet(self, name, rid):
        package = self.package
        relation = package.rels(self.part).get(rid)
        kind = package.kind(relation) if relation is not None else None
        if kind in {"dialogsheet", "macrosheet", "intlMacrosheet"}:
            return
        if kind not in {"worksheet", "chartsheet"}:
            raise ValueError(f"invalid worksheet or chartsheet registration r:id {rid!r}")
        part = package.resolve(self.part, rid, kind)
        root = package.xml(part)
        if root.tag != self.ns + kind:
            raise ValueError(f"{part}: expected a {kind} XML root")
        if kind == "worksheet":
            key = name.casefold()
            if key in self.sheets:
                raise ValueError(f"duplicate worksheet name {name!r}")
            self.sheets[key] = part
        for drawing in root.iter(self.ns + "drawing"):
            try:
                drawing_part = package.resolve(part, relationship_id(drawing), "drawing")
                self.drawings.add(drawing_part)
                self.inspect_drawing(name, drawing_part)
            except (ValueError, KeyError) as exc:
                self.error(str(exc), sheet=name)

    def inspect_drawing(self, name, part):
        package = self.package
        root = package.xml(part)
        drawing_namespaces = (
            "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
            "http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing",
        )
        if root.tag not in {qualified(ns, "wsDr") for ns in drawing_namespaces}:
            raise ValueError(f"{part}: expected a spreadsheet drawing XML root")
        for node in root.iter():
            extended = node.tag == qualified(CHART_EXT_NS, "chart")
            if not extended and node.tag not in CHART_REFS:
                continue
            rid = relationship_id(node)
            try:
                chart = package.resolve(part, rid, "chartEx" if extended else "chart")
                self.reachable_charts.setdefault(chart, set()).add(name)
                content_type = package.content_type(chart)
                if content_type != (CHART_EXT_TYPE if extended else CHART_TYPE):
                    raise ValueError(f"{chart}: expected chart content type, found {content_type!r}")
            except (ValueError, KeyError) as exc:
                self.error(str(exc), sheet=name, drawing=part, relationship_id=rid)
                continue
            if extended:
                state = sha256(package.archive.read(package.members[chart])).hexdigest()
                self.error("unsupported extended chart", sheet=name, drawing=part, chart=chart,
                           relationship_id=rid, chart_state=state)
            else:
                self.charts.setdefault(chart, set()).add(name)

    def read_shared_strings(self):
        if self.shared_strings is None:
            ids = self.package.related(self.part, "sharedStrings")
            if len(ids) != 1:
                raise ValueError("expected one sharedStrings relationship")
            part = self.package.resolve(self.part, ids[0], "sharedStrings")
            root = self.package.xml(part)
            if root.tag != self.ns + "sst":
                raise ValueError(f"{part}: invalid shared strings XML root")
            self.shared_strings = [cell_text(item, self.ns) for item in root.findall(self.ns + "si")]
        return self.shared_strings

    def cell_value(self, cell):
        kind = cell.get("t", "n")
        formula = cell.find(self.ns + "f")
        value = cell.find(self.ns + "v")
        if kind == "inlineStr":
            inline = cell.find(self.ns + "is")
            if inline is not None:
                return "s", cell_text(inline, self.ns)
        if value is None or (value.text is None and kind != "str"):
            return kind, MISSING_FORMULA_CACHE if formula is not None else None
        raw = value.text or ""
        if kind == "s":
            index = int(raw)
            strings = self.read_shared_strings()
            if not 0 <= index < len(strings):
                raise ValueError(f"invalid shared string index {index}")
            return kind, strings[index]
        if kind == "d":
            date = from_ISO8601(raw)
            serial = date.total_seconds() / 86400 if isinstance(date, timedelta) else to_excel(date, self.epoch)
            return "n", str(serial)
        return kind, raw

    def sheet_cells(self, name):
        if name not in self.sheets:
            raise ValueError(f"unknown worksheet {name!r}")
        if name in self.cells:
            return self.cells[name]
        root = self.package.xml(self.sheets[name])
        rows = root.find(self.ns + "sheetData")
        cells = {}
        row_number = 0
        if rows is not None:
            for row in rows.findall(self.ns + "row"):
                row_number = int(row.get("r", row_number + 1))
                column = 0
                for cell in row.findall(self.ns + "c"):
                    address = cell.get("r")
                    location = coordinate_to_tuple(address) if address else (row_number, column + 1)
                    column = location[1]
                    if location in cells:
                        raise ValueError(f"{name}: duplicate cell {address or location}")
                    cells[location] = cell
        self.cells[name] = cells
        return cells

    def values(self, formula, numeric):
        name, c1, r1, c2, r2 = parse_reference(formula)
        cells = self.sheet_cells(name.casefold())
        length = max(c2 - c1, r2 - r1) + 1
        points = {}
        errors = []
        for idx in range(length):
            row = r1 + idx if r2 > r1 else r1
            col = c1 + idx if c2 > c1 else c1
            cell = cells.get((row, col))
            if cell is None:
                continue
            address = f"{name}!{get_column_letter(col)}{row}"
            try:
                value = self.chart_value(cell, numeric)
                if value is not None:
                    points[idx] = value
            except (KeyError, ValueError, OverflowError) as exc:
                errors.append(f"{address}: {exc}")
        return length, points, errors

    def chart_value(self, cell, numeric):
        kind, value = self.cell_value(cell)
        if value is MISSING_FORMULA_CACHE:
            raise ValueError("formula has no cached result")
        if value in (None, ""):
            return None
        if kind == "e" and value != "#N/A":
            raise ValueError(f"cached worksheet error {value}")
        if not numeric:
            return {"1": "TRUE", "0": "FALSE"}[value] if kind == "b" else value
        if ((kind == "b" and value in {"0", "1"})
                or (kind == "n" and math.isfinite(float(value))) or kind == "e"):
            return value
        raise ValueError(f"unsupported numeric chart value {value!r}")


def parse_reference(formula):
    token = formula.strip().removeprefix("=")
    if "[" in token or "]" in token:
        raise ValueError("unsupported external or structured reference")
    match = LOCAL_REFERENCE.fullmatch(token)
    if match is None:
        if "," in token:
            raise ValueError("unsupported multi-area reference")
        raise ValueError("unsupported reference, expected a worksheet-qualified A1 range")
    sheet, area = match.group("sheet", "area")
    if "#REF!" in area:
        raise ValueError("broken #REF! series reference")
    if "," in area:
        raise ValueError("unsupported multi-area reference")
    if not CELL_RANGE.fullmatch(area):
        raise ValueError("unsupported reference, expected a bounded A1 range")
    if sheet.startswith("'"):
        sheet = sheet[1:-1].replace("''", "'")
    if ":" in sheet:
        raise ValueError("unsupported 3-D sheet reference")
    c1, r1, c2, r2 = range_boundaries(area.upper())
    if not (1 <= c1 <= c2 <= 16384 and 1 <= r1 <= r2 <= 1048576):
        raise ValueError("range is outside worksheet bounds or is reversed")
    if c1 != c2 and r1 != r2:
        raise ValueError("unsupported two-dimensional series reference")
    return sheet, c1, r1, c2, r2


@dataclass
class Span:
    start: int
    close: int = 0


class ChartXML:
    """Use parsed elements for comparison and original byte offsets for edits."""
    def __init__(self, data):
        self.data = data
        self.spans = {}
        self.edits = []
        builder = TreeBuilder()
        stack = []
        parser = expat.ParserCreate(namespace_separator="}")

        def name(tag):
            return "{" + tag if "}" in tag else tag

        def start(tag, attrs):
            element = builder.start(name(tag), {name(key): value for key, value in attrs.items()})
            self.spans[element] = Span(parser.CurrentByteIndex)
            stack.append(element)

        def end(tag):
            self.spans[stack.pop()].close = parser.CurrentByteIndex
            builder.end(name(tag))

        def xml_decl(_version, encoding, _standalone):
            if encoding and encoding.upper() not in {"UTF-8", "UTF8", "US-ASCII"}:
                raise ValueError(f"unsupported chart XML encoding {encoding}")

        def doctype(*_args):
            raise ValueError("chart XML must not declare a DTD")

        parser.StartElementHandler = start
        parser.EndElementHandler = end
        parser.CharacterDataHandler = builder.data
        parser.StartDoctypeDeclHandler = doctype
        parser.XmlDeclHandler = xml_decl
        if data.startswith((b"\xff\xfe", b"\xfe\xff")) or b"\x00" in data:
            raise ValueError("unsupported chart XML encoding")
        parser.Parse(data, True)
        self.root = builder.close()

    def opening(self, node):
        return TAG.match(self.data, self.spans[node].start)

    def qname(self, node):
        return re.match(rb"<([^\s/>]+)", self.opening(node)[0])[1]

    def element_end(self, node):
        opening = self.opening(node)
        if opening[0].endswith(b"/>"):
            return opening.end()
        return TAG.match(self.data, self.spans[node].close).end()

    def replace_text(self, node, value):
        opening = self.opening(node)
        text = xml_text(value)
        if opening[0].endswith(b"/>"):
            self.edits.append((opening.end() - 2, opening.end(),
                               b">" + text + b"</" + self.qname(node) + b">"))
        else:
            close = self.spans[node].close
            if b"<" in self.data[opening.end():close]:
                raise ValueError("cache value contains XML markup that cannot be edited in place")
            self.edits.append((opening.end(), close, text))

    def replace_count(self, node, value):
        opening = self.opening(node)
        attributes_start = opening.start() + 1 + len(self.qname(node))
        for match in ATTRIBUTE.finditer(self.data, attributes_start, opening.end()):
            if match[1] == b"val":
                start, end = match.span(2 if match[2] is not None else 3)
                self.edits.append((start, end, str(value).encode("ascii")))
                return
        insert = opening.end() - (2 if opening[0].endswith(b"/>") else 1)
        self.edits.append((insert, insert, b' val="' + str(value).encode("ascii") + b'"'))

    def append_inside(self, node, data, *, before=None):
        if before is not None:
            insert = self.spans[before].start
            self.edits.append((insert, insert, data))
            return
        opening = self.opening(node)
        if opening[0].endswith(b"/>"):
            self.edits.append((opening.end() - 2, opening.end(),
                               b">" + data + b"</" + self.qname(node) + b">"))
        else:
            insert = self.spans[node].close
            self.edits.append((insert, insert, data))

    def patched(self):
        chunks, cursor = [], 0
        for start, end, replacement in sorted(self.edits, key=lambda edit: (edit[0], edit[1])):
            if start < cursor:
                raise ValueError("overlapping chart XML edits")
            chunks.extend((self.data[cursor:start], replacement))
            cursor = end
        return b"".join([*chunks, self.data[cursor:]])


def part_digests(package, part):
    """Hash raw part bytes and, where permitted, bytes outside editable XML."""
    member = package.members[part]
    chart_part = package.content_type(part) == CHART_TYPE
    if not chart_part and part not in DOCUMENT_PROPERTIES:
        with package.archive.open(member) as stream:
            return file_digest(stream, "sha256").hexdigest(), None

    data = package.archive.read(member)
    raw = sha256(data).hexdigest()
    try:
        xml = ChartXML(data)
    except (ValueError, expat.ExpatError):
        # A malformed or unsupported part can only match byte for byte.
        return raw, None
    if chart_part:
        caches = []
        for ns in CHART_NAMESPACES:
            for ref_tag, cache_tag in (("numRef", "numCache"), ("strRef", "strCache")):
                for ref in xml.root.iter(qualified(ns, ref_tag)):
                    caches.extend(ref.findall(qualified(ns, cache_tag)))
        end = 0
        for cache in sorted(caches, key=lambda node: xml.spans[node].start):
            start = xml.spans[cache].start
            if start >= end:
                end = xml.element_end(cache)
                xml.edits.append((start, end, b""))
    else:
        for date in xml.root.findall(MODIFIED_DATE):
            start, end = xml.opening(date).end(), xml.spans[date].close
            if b"<" not in data[start:end]:
                xml.edits.append((start, end, b""))
    return raw, sha256(xml.patched()).hexdigest()


def xml_text(value):
    return escape(value, {"\r": "&#13;"}).encode("ascii", "xmlcharrefreplace")


def unsigned(value):
    if value is None or re.fullmatch(r"[0-9]+", value) is None:
        return None
    return int(value)


def same_value(actual, expected, numeric):
    if actual == expected:
        return True
    if not numeric or actual is None or expected in (None, "#N/A"):
        return False
    try:
        return math.isclose(float(actual), float(expected), rel_tol=1e-12)
    except ValueError:
        return False


def mismatch_key(location):
    return (location["chart"], tuple(location["sheets"]), location["series"],
            location["series_idx"], location["field"], location["reference"], location["reference_type"])


@dataclass
class CacheMismatch:
    expected_count: int
    actual_count: str | None
    count_changed: bool
    points: dict

    def report(self, location):
        return {**location, "expected_pt_count": self.expected_count,
                "actual_pt_count": self.actual_count, "point_count_mismatch": self.count_changed,
                "mismatched_points": len(self.points),
                "points": [{"idx": idx, "expected": expected, "actual": actual}
                           for idx, (expected, actual) in self.points.items()]}

    def inherited_from(self, baseline, numeric):
        count_changed = (self.count_changed and baseline.count_changed
                         and self.expected_count == baseline.expected_count
                         and (self.actual_count == baseline.actual_count
                              or (unsigned(self.actual_count) is not None
                                  and unsigned(self.actual_count) == unsigned(baseline.actual_count))))
        points = {idx: state for idx, state in self.points.items()
                  if idx in baseline.points and all(same_value(a, b, numeric)
                                                    for a, b in zip(state, baseline.points[idx]))}
        return CacheMismatch(self.expected_count, self.actual_count, count_changed, points)


class Baseline:
    version = 2

    def __init__(self, snapshot):
        try:
            if type(snapshot["version"]) is not int or snapshot["version"] != self.version:
                raise ValueError("unsupported baseline version; capture it again from the original workbook")
            self.parts = set(snapshot["parts"])
            self.part_sha256 = snapshot["part_sha256"]
            self.normalized_sha256 = snapshot["normalized_sha256"]
            if (not isinstance(snapshot["parts"], list) or not self.parts
                    or any(not isinstance(part, str) for part in self.parts)
                    or len(self.parts) != len(snapshot["parts"])
                    or self.part_sha256.keys() != self.parts
                    or not self.normalized_sha256.keys() <= self.parts
                    or any(not isinstance(digest, str) or not SHA256_HEX.fullmatch(digest)
                           for hashes in (self.part_sha256, self.normalized_sha256) for digest in hashes.values())):
                raise ValueError("invalid baseline part fingerprints")
            self.charts = snapshot["reachable_charts"]
            if any(not isinstance(sheets, list) or not sheets
                   or any(not isinstance(sheet, str) for sheet in sheets)
                   for sheets in self.charts.values()):
                raise ValueError("invalid reachable chart inventory")
            errors, mismatches = snapshot["errors"], snapshot["mismatches"]
            if not isinstance(errors, list) or not isinstance(mismatches, list):
                raise ValueError("invalid baseline findings")
            if any(not isinstance(error.get("reason"), str) for error in errors):
                raise ValueError("invalid baseline errors")
            self.errors = Counter(json.dumps(error, sort_keys=True) for error in errors)
            self.mismatches = {}
            for entry in mismatches:
                expected, actual = entry["expected_pt_count"], entry["actual_pt_count"]
                count_changed = entry["point_count_mismatch"]
                points = {point["idx"]: (point["expected"], point["actual"]) for point in entry["points"]}
                if (type(expected) is not int or type(count_changed) is not bool
                        or (actual is not None and not isinstance(actual, str))
                        or len(points) != entry["mismatched_points"] or len(points) != len(entry["points"])
                        or any(type(idx) is not int or any(value is not None and not isinstance(value, str)
                                                          for value in state) for idx, state in points.items())):
                    raise ValueError("invalid baseline cache mismatch")
                self.mismatches[mismatch_key(entry)] = CacheMismatch(expected, actual, count_changed, points)
        except (AttributeError, KeyError, TypeError) as exc:
            raise ValueError("invalid chart baseline snapshot") from exc

    @classmethod
    def snapshot(cls, package, report):
        raw, normalized = {}, {}
        for part, member in package.members.items():
            raw[member.filename], normalized_digest = part_digests(package, part)
            if normalized_digest is not None:
                normalized[member.filename] = normalized_digest
        return {"version": cls.version, "parts": sorted(raw), "part_sha256": raw,
                "normalized_sha256": normalized, **{key: report[key] for key in
                                                    ("reachable_charts", "errors", "mismatches")}}

    def mismatching_parts(self, package):
        filenames = {member.filename for member in package.members.values()}
        mismatches = self.parts ^ filenames
        for filename in self.parts & filenames:
            part = _part_key(filename)
            if (package.content_type(part) or "").lower() in MUTABLE_PART_TYPES:
                continue
            raw, normalized = part_digests(package, part)
            if (raw != self.part_sha256[filename]
                    and (normalized is None or normalized != self.normalized_sha256.get(filename))):
                mismatches.add(filename)
        return sorted(mismatches)


def record_mismatch(workbook, location, difference, numeric):
    report = workbook.report
    baseline = workbook.baseline
    previous = baseline.mismatches.get(mismatch_key(location)) if baseline else None
    if previous is not None:
        inherited = difference.inherited_from(previous, numeric)
        if inherited.points or inherited.count_changed:
            report["inherited"]["mismatches"].append(inherited.report(location))
            difference = CacheMismatch(difference.expected_count, difference.actual_count,
                                       difference.count_changed and not inherited.count_changed,
                                       {idx: state for idx, state in difference.points.items()
                                        if idx not in inherited.points})
    if difference.points or difference.count_changed:
        report["mismatches"].append(difference.report(location))
    return difference


def compare_cache(chart, ns, ref, numeric, expected_count, expected, workbook, location,
                  *, refresh, refresh_all):
    cache_tag = "numCache" if numeric else "strCache"
    other_cache = "strCache" if numeric else "numCache"
    if ref.find(ns + other_cache) is not None:
        raise ValueError("cache type does not match the series reference")
    caches = ref.findall(ns + cache_tag)
    if len(caches) > 1:
        raise ValueError("multiple caches for one series reference")
    cache = caches[0] if caches else None
    counts = cache.findall(ns + "ptCount") if cache is not None else []
    if len(counts) > 1:
        raise ValueError("multiple point counts in one cache")
    count = counts[0] if counts else None
    count_value = count.get("val") if count is not None else None
    actual = {}
    if cache is not None:
        for point in cache.findall(ns + "pt"):
            idx = unsigned(point.get("idx"))
            values = point.findall(ns + "v")
            if idx is None or idx in actual or len(values) != 1 or len(values[0]):
                raise ValueError("cache has an invalid or duplicate point index or value")
            actual[idx] = point, values[0]
    actual_values = {idx: value.text or "" for idx, (_, value) in actual.items()}

    changed = {idx: (expected.get(idx), actual_values.get(idx))
               for idx in sorted(expected.keys() | actual.keys())
               if not same_value(actual_values.get(idx), expected.get(idx), numeric)}
    count_changed = unsigned(count_value) != expected_count
    if not changed and not count_changed:
        return
    difference = CacheMismatch(expected_count, count_value, count_changed, changed)
    new = record_mismatch(workbook, location, difference, numeric)
    selected = difference if refresh_all else new
    if not refresh or (not selected.points and not selected.count_changed):
        return

    owner = cache if cache is not None else ref
    prefix = chart.qname(owner).rpartition(b":")[0]
    prefix = prefix + b":" if prefix else b""
    count_bytes = b"<%sptCount val=\"%d\"/>" % (prefix, expected_count) if selected.count_changed else b""
    insert_points = {
        idx: b"<%spt idx=\"%d\"><%sv>%s</%sv></%spt>" %
        (prefix, idx, prefix, xml_text(expected[idx]), prefix, prefix)
        for idx in selected.points if idx not in actual
    }
    if cache is None:
        tag = prefix + cache_tag.encode("ascii")
        body = count_bytes + b"".join(insert_points.values())
        chart.append_inside(ref, b"<" + tag + b">" + body + b"</" + tag + b">",
                            before=ref.find(ns + "extLst"))
        return
    points = cache.findall(ns + "pt")
    extension = cache.find(ns + "extLst")
    if selected.count_changed and count is not None:
        chart.replace_count(count, expected_count)
    count_insert = count_bytes if count is None else b""
    if not points:
        body = count_insert + b"".join(insert_points.values())
        if body:
            chart.append_inside(cache, body, before=extension)
        return
    if count_insert:
        chart.append_inside(cache, count_insert, before=points[0])
    existing_indices = sorted(actual)
    for idx, data in insert_points.items():
        next_index = bisect_right(existing_indices, idx)
        next_node = actual[existing_indices[next_index]][0] if next_index < len(existing_indices) else extension
        chart.append_inside(cache, data, before=next_node)
    for idx in selected.points:
        if idx in actual:
            point, value = actual[idx]
            if idx in expected:
                chart.replace_text(value, expected[idx])
            else:
                # A sparse cache omits the point at a blank source cell.
                chart.edits.append((chart.spans[point].start, chart.element_end(point), b""))


def chart_series(data, workbook, part, *, refresh, refresh_all):
    chart = ChartXML(data)
    ns = chart.root.tag.removesuffix("chartSpace")
    if ns not in {f"{{{namespace}}}" for namespace in CHART_NAMESPACES}:
        raise ValueError("chart part does not have a supported chartSpace root")
    if chart.root.find(ns + "chart") is None:
        raise ValueError("chartSpace is missing its chart")
    for series, element in enumerate(chart.root.iter(ns + "ser"), 1):
        edits_start = len(chart.edits)
        errors_start = len(workbook.report["errors"])
        checked_fields = set()
        series_index = element.find(ns + "idx")
        series_location = {
            "chart": part, "sheets": sorted(workbook.charts[part]), "series": series,
            "series_idx": series_index.get("val") if series_index is not None else None,
        }
        for field in element:
            if not field.tag.startswith(ns) or field.tag[len(ns):] not in SERIES_FIELDS:
                continue
            field_name = field.tag[len(ns):]
            if field_name in checked_fields:
                workbook.error("duplicate chart series field", **series_location, field=field_name)
                continue
            checked_fields.add(field_name)
            references = [child for child in field if child.tag.startswith(ns)
                          and child.tag.endswith("Ref")]
            if len(references) > 1 or (not references and next(field.iter(ns + "f"), None) is not None):
                workbook.error("unsupported series reference layout", **series_location, field=field_name)
                continue
            for ref in references:
                formulas = ref.findall(ns + "f")
                formula = formulas[0].text if len(formulas) == 1 else None
                location = {
                    **series_location, "field": field_name, "reference": formula,
                    "reference_type": ref.tag[len(ns):],
                }
                try:
                    if not formula:
                        raise ValueError("series reference must have one nonempty formula")
                    if ref.tag not in {ns + "numRef", ns + "strRef"}:
                        raise ValueError(f"unsupported series reference type {ref.tag[len(ns):]}")
                    numeric = ref.tag == ns + "numRef"
                    count, points, errors = workbook.values(formula, numeric)
                    if errors:
                        for reason in errors:
                            workbook.error(reason, **location)
                        continue
                    workbook.report["references_checked"] += 1
                    compare_cache(chart, ns, ref, numeric, count, points, workbook, location,
                                  refresh=refresh, refresh_all=refresh_all)
                except (KeyError, ValueError, OverflowError) as exc:
                    workbook.error(str(exc), **location)
        if len(workbook.report["errors"]) > errors_start:
            # A series with any unverifiable field stays byte-for-byte intact.
            del chart.edits[edits_start:]
            state = sha256(tostring(element)).hexdigest()
            for error in workbook.report["errors"][errors_start:]:
                error["series_state"] = state
    return chart.patched() if refresh and chart.edits else None


def empty_report(path, baseline):
    report = {"file": str(path), "package_readable": False, "reachable_charts": {},
              "charts_checked": 0, "references_checked": 0, "errors": [], "mismatches": []}
    if baseline is not None:
        report["inherited"] = {"errors": [], "mismatches": []}
    return report


def compare_errors(report, baseline):
    available = baseline.errors.copy()
    new = []
    detached = {error["chart"]: error for error in report["errors"]
                if error["reason"] == "registered chart is unreachable from workbook sheets"}
    for part, sheets in baseline.charts.items():
        missing = sorted(set(sheets) - set(report["reachable_charts"].get(part, [])))
        if not missing:
            continue
        if part in detached:
            detached[part]["baseline_sheets"] = missing
        else:
            new.append({"chart": part, "baseline_sheets": missing,
                        "reason": "chart is no longer reachable from its baseline sheets"})
    for error in report["errors"]:
        state = json.dumps(error, sort_keys=True)
        if available[state]:
            report["inherited"]["errors"].append(error)
            available[state] -= 1
        else:
            new.append(error)
    report["errors"] = new


def analyze_archive(archive, path, baseline=None, *, refresh=False, refresh_all=False):
    report = empty_report(path, baseline)
    updates = {}
    try:
        package = Package(archive)
        if baseline is not None:
            mismatches = baseline.mismatching_parts(package)
            if mismatches:
                report["lineage_mismatches"] = mismatches
                # Diagnose the target independently. Its findings cannot be inherited.
                baseline = None
                refresh = False
        workbook = Workbook(package, report, baseline)
        report["package_readable"] = True
        report["reachable_charts"] = {part: sorted(workbook.reachable_charts[part])
                                      for part in sorted(workbook.reachable_charts)}
        for part in sorted(workbook.charts):
            member = package.members[part]
            data = None
            try:
                report["charts_checked"] += 1
                data = archive.read(member)
                updated = chart_series(data, workbook, part, refresh=refresh, refresh_all=refresh_all)
                if updated is not None:
                    updates[member.filename] = updated
            except (ValueError, KeyError, expat.ExpatError, zipfile.BadZipFile) as exc:
                workbook.error(str(exc), chart=part, sheets=sorted(workbook.charts[part]),
                               chart_state=sha256(data).hexdigest() if data is not None else None)
    except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile) as exc:
        report["package_readable"] = False
        report["errors"].append({"reason": str(exc)})
    if baseline is not None and report["package_readable"]:
        compare_errors(report, baseline)
    failed = report["errors"] or report["mismatches"] or report.get("lineage_mismatches")
    report["status"] = "failed" if failed else "passed"
    return report, updates


def check(path, baseline=None, *, capture_baseline=False):
    try:
        with zipfile.ZipFile(path) as archive:
            report, _ = analyze_archive(archive, path, baseline)
            snapshot = None
            if capture_baseline and report["package_readable"] and not report.get("lineage_mismatches"):
                findings = report if baseline is None else analyze_archive(archive, path)[0]
                snapshot = Baseline.snapshot(Package(archive), findings)
            return report, snapshot
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
        return {**empty_report(path, baseline), "status": "failed", "errors": [{"reason": str(exc)}]}, None


def same_file(first, second):
    return first.resolve() == second.resolve() or (first.exists() and second.exists() and first.samefile(second))


def refresh(source, output, baseline=None, *, refresh_all=False):
    result = {"file": str(source), "output": str(output), "changed_parts": [], "status": "failed"}
    try:
        if same_file(source, output):
            raise ValueError("refresh requires a separate output workbook")
        with source.open("rb") as source_file, zipfile.ZipFile(source_file) as original:
            report, updates = analyze_archive(original, source, baseline, refresh=True, refresh_all=refresh_all)
            result["before"] = report
            if not report["package_readable"] or report.get("lineage_mismatches"):
                return result
            with tempfile.TemporaryDirectory(dir=output.parent) as scratch:
                temporary = Path(scratch) / output.name
                if updates:
                    with zipfile.ZipFile(temporary, "w") as edited:
                        edited.comment = original.comment
                        for member in original.infolist():
                            data = updates.get(member.filename)
                            edited.writestr(copy(member), original.read(member) if data is None else data)
                else:
                    source_file.seek(0)
                    with temporary.open("wb") as destination:
                        shutil.copyfileobj(source_file, destination)
                verified, _ = check(temporary, baseline)
                verified["file"] = str(output)
                result["after"] = verified
                if verified["package_readable"] and not verified.get("lineage_mismatches"):
                    os.replace(temporary, output)
                    result["changed_parts"] = sorted(updates)
                    result["status"] = verified["status"]
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
        result["error"] = str(exc)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check_command = commands.add_parser("check")
    refresh_command = commands.add_parser("refresh")
    for command in (check_command, refresh_command):
        command.add_argument("file", type=Path)
        baseline_options = command.add_mutually_exclusive_group()
        baseline_options.add_argument("--baseline", type=Path, help="compare with the original workbook")
        baseline_options.add_argument("--baseline-json", type=Path, help="compare with a saved baseline")
        if command is check_command:
            baseline_options.add_argument("--save-baseline", type=Path, help="save this workbook's chart baseline")
    refresh_command.add_argument("-o", "--output", required=True, type=Path)
    refresh_command.add_argument("--all", action="store_true", help="also refresh inherited stale cache points")
    args = parser.parse_args()
    try:
        baseline = None
        baseline_path = args.baseline or args.baseline_json
        if baseline_path:
            if args.command == "refresh" and same_file(baseline_path, args.output):
                raise ValueError("refresh output must be separate from the baseline")
            if args.baseline:
                original, snapshot = check(args.baseline, capture_baseline=True)
                if snapshot is None:
                    raise ValueError(f"cannot capture baseline: {original['errors'][0]['reason']}")
            else:
                snapshot = json.loads(args.baseline_json.read_text(encoding="utf-8"))
            baseline = Baseline(snapshot)
        if args.command == "check":
            report, snapshot = check(args.file, baseline, capture_baseline=args.save_baseline is not None)
            if args.save_baseline:
                if same_file(args.file, args.save_baseline):
                    raise ValueError("baseline JSON must be separate from the workbook")
                if snapshot is not None:
                    with tempfile.TemporaryDirectory(dir=args.save_baseline.parent) as scratch:
                        temporary = Path(scratch) / args.save_baseline.name
                        temporary.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                        os.replace(temporary, args.save_baseline)
                    report["saved_baseline"] = str(args.save_baseline)
        else:
            report = refresh(args.file, args.output, baseline, refresh_all=args.all)
    except (OSError, ValueError) as exc:
        report = {"file": str(args.file), "status": "failed", "error": str(exc)}
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
