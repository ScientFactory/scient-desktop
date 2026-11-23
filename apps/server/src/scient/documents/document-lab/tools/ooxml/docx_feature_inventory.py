"""Count preservation-sensitive Word XML elements by package part."""

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import posixpath
import stat
from urllib.parse import unquote, urlsplit
import unicodedata
import zipfile

from defusedxml import ElementTree as XML
from defusedxml.common import DefusedXmlException

MAX_MEMBERS = 10_000
MAX_EXPANDED_BYTES = 512 * 1024**2
MAX_MEMBER_BYTES = 128 * 1024**2

WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
STRICT_WORD_NS = "http://purl.oclc.org/ooxml/wordprocessingml/main"
WORD_NAMESPACES = (WORD_NS, STRICT_WORD_NS)
MATH_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"
STRICT_MATH_NS = "http://purl.oclc.org/ooxml/officeDocument/math"
VML_NS = "urn:schemas-microsoft-com:vml"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
TRANSITIONAL_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
STRICT_RELS = "http://purl.oclc.org/ooxml/officeDocument/relationships"
WORD_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml."

PROPERTY_CHANGES = {
    f"{name}Change": name for name in ("rPr", "pPr", "sectPr", "tblPr", "trPr", "tcPr")
}
STORY_OWNER_NAMES = ("comment", "footnote", "endnote", "txbxContent")
STORY_OWNER_TAGS = {f"{{{ns}}}{name}" for ns in WORD_NAMESPACES for name in STORY_OWNER_NAMES}
PROPERTY_CHANGE_TAGS = {f"{{{ns}}}{name}" for ns in WORD_NAMESPACES for name in PROPERTY_CHANGES}
FIELD_CHAR_TYPES = {f"{{{ns}}}fldChar": f"{{{ns}}}fldCharType" for ns in WORD_NAMESPACES}
PARAGRAPH_MATH_PATHS = {
    tuple(f"{{{ns}}}{name}" for name in ("p", "pPr", "rPr", "oMath"))
    for ns in WORD_NAMESPACES
}
PARAGRAPH_MATH_TAGS = {path[-1] for path in PARAGRAPH_MATH_PATHS}
BALANCED_FIELDS = "field:balanced"
MALFORMED_FIELDS = "field:malformed"
MOVES = {"moveFrom", "moveTo"}
MOVE_MARKERS = {f"{side}Range{end}" for side in MOVES for end in ("Start", "End")}
DELETED_TEXT = {"delText": "t", "delInstrText": "instrText"}
TEXT_REVISIONS = {"ins", "del"} | MOVES
SUPPORTED_REVISIONS = (
    set(PROPERTY_CHANGES) | MOVE_MARKERS | set(DELETED_TEXT) | TEXT_REVISIONS
    | {"cellIns", "cellDel", "numberingChange"}
)
UNSUPPORTED_REVISIONS = (
    {"cellMerge", "tblGridChange", "tblPrExChange"}
    | {f"customXml{kind}Range{end}" for kind in ("Ins", "Del", "MoveFrom", "MoveTo")
       for end in ("Start", "End")}
)
WORD_2010_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
WORD_CONFLICTS = (
    {"conflictIns", "conflictDel"}
    | {f"customXmlConflict{kind}Range{end}" for kind in ("Ins", "Del")
       for end in ("Start", "End")}
)
REVISION_FEATURES = (
    {f"w:{name}" for name in SUPPORTED_REVISIONS | UNSUPPORTED_REVISIONS}
    | {f"w14:{name}" for name in WORD_CONFLICTS}
)
COMMENT_METADATA = {
    "commentsExtended": ("2012/wordml", "commentsEx"),
    "commentsIds": ("2016/wordml/cid", "commentsIds"),
    "commentsExtensible": ("2018/wordml/cex", "commentsExtensible"),
    "people": ("2012/wordml", "people"),
}
COMMENT_METADATA_ROOTS = {
    f"{{http://schemas.microsoft.com/office/word/{namespace}}}{root}": f"part:{name}"
    for name, (namespace, root) in COMMENT_METADATA.items()
}
COMMENT_METADATA_TYPES = {
    f"{WORD_CONTENT_TYPE}{name.casefold()}+xml": f"part:{name}" for name in COMMENT_METADATA
}
WORD_FEATURES = (
    "fldChar", "fldSimple", "instrText", "bookmarkStart", "bookmarkEnd", "sdt",
    "footnoteReference", "endnoteReference", "drawing", "object", "sectPr",
    "comment", "commentRangeStart", "commentRangeEnd", "commentReference",
)
FEATURE_TAGS = {
    f"{{{namespace}}}{name}": f"w:{name}"
    for namespace in WORD_NAMESPACES
    for name in set(WORD_FEATURES) | SUPPORTED_REVISIONS | UNSUPPORTED_REVISIONS
}
FEATURE_TAGS.update({f"{{{WORD_2010_NS}}}{name}": f"w14:{name}" for name in WORD_CONFLICTS})
FEATURE_TAGS.update({
    f"{{{namespace}}}{name}": f"m:{name}"
    for namespace in (MATH_NS, STRICT_MATH_NS)
    for name in ("oMath", "oMathPara")
})
FEATURE_TAGS[f"{{{VML_NS}}}shape"] = "v:shape"
FEATURES = sorted(set(FEATURE_TAGS.values()) | set(COMMENT_METADATA_TYPES.values())
                  | {"w:oMath", BALANCED_FIELDS, MALFORMED_FIELDS})
FEATURE_NAMES = {kind.split(":")[1]: kind for kind in FEATURES}
FEATURE_NAMES["oMath"] = "m:oMath"  # Preserve the existing unqualified name.


class ComplexFieldScan:
    """Read delimiters in one story, independent of the XML parser."""

    def __init__(self):
        self.open_fields = []

    def delimiter(self, kind, marker=None):
        """Return (parent begin, marker identities, issue) when a group ends."""
        stack = self.open_fields
        if kind == "begin":
            stack.append([marker])
        elif kind == "separate" and stack:
            stack[-1].append(marker)
        elif kind == "end" and stack:
            markers = stack.pop()
            parent = stack[-1][0] if stack else None
            issue = "more than one separator" if len(markers) > 2 else None
            return parent, (*markers, marker), issue
        else:
            parent = stack[-1][0] if stack else None
            issue = (f"{kind} without a begin" if kind in ("separate", "end")
                     else "unknown delimiter type")
            return parent, (marker,), issue

    def unclosed(self):
        for index, markers in enumerate(self.open_fields):
            parent = self.open_fields[index - 1][0] if index else None
            yield parent, tuple(markers), "begin without an end"


def check_entry_budget(sizes) -> None:
    total = 0
    for count, size in enumerate(sizes, start=1):
        total += size
        if count > MAX_MEMBERS or total > MAX_EXPANDED_BYTES:
            raise ValueError("package exceeds the 10,000-entry or 512 MiB expanded budget")
        if size > MAX_MEMBER_BYTES:
            raise ValueError("package contains an entry larger than 128 MiB expanded")


def part_key(name: str) -> str:
    return unicodedata.normalize("NFC", unquote(name, errors="strict")).casefold()


def check_zip_members(archive: zipfile.ZipFile) -> None:
    """Check names and declared expansion before reading any member."""
    entries = archive.infolist()
    check_entry_budget(entry.file_size for entry in entries)
    seen, files = set(), set()
    for entry in entries:
        name = entry.filename.removesuffix("/")
        key = part_key(name)
        if (
            PureWindowsPath(key).anchor or "\\" in key or "\0" in key
            or any(piece in ("", ".", "..") for piece in key.split("/"))
            or entry.orig_filename != entry.filename or stat.S_ISLNK(entry.external_attr >> 16)
        ):
            raise ValueError(f"unsafe ZIP entry: {entry.orig_filename!r}")
        if key in seen:
            raise ValueError(f"duplicate ZIP entry: {entry.filename!r}")
        seen.add(key)
        if not entry.is_dir():
            files.add(key)
    for key in seen:
        while "/" in key:
            key = key.rsplit("/", 1)[0]
            if key in files:
                raise ValueError(f"ZIP entry is both a file and a parent directory: {key!r}")


def _read_xml(archive, part):
    with archive.open(part) as source:
        return XML.parse(source, forbid_dtd=True).getroot()


def _content_types(archive):
    root = _read_xml(archive, "[Content_Types].xml")
    if root.tag != f"{{{CONTENT_TYPES_NS}}}Types":
        raise ValueError("invalid [Content_Types].xml root")
    overrides = {
        part_key(element.attrib["PartName"].removeprefix("/")): element.attrib["ContentType"]
        for element in root.findall(f"{{{CONTENT_TYPES_NS}}}Override")
    }
    defaults = {
        element.attrib["Extension"].casefold(): element.attrib["ContentType"]
        for element in root.findall(f"{{{CONTENT_TYPES_NS}}}Default")
    }
    return overrides, defaults


def relationships_path(owner: str) -> str:
    part = PurePosixPath(owner)
    return str(part.parent / "_rels" / f"{part.name}.rels") if owner else "_rels/.rels"


def relationship_target(owner: str, attributes: dict) -> str | None:
    if attributes.get("TargetMode", "").casefold() == "external":
        return None
    try:
        target = urlsplit(attributes.get("Target", ""))
        path = unquote(target.path, errors="strict")
    except ValueError:
        return None
    if (target.scheme or target.netloc or target.query or not path
            or "\\" in path or "\0" in path):
        return None
    joined = path.lstrip("/") if path.startswith("/") else posixpath.join(posixpath.dirname(owner), path)
    name = posixpath.normpath(joined)
    if name in ("", ".", "..") or name.startswith("../"):
        return None
    # ZIP member names are matched by their decoded, case-folded form.
    return unicodedata.normalize("NFC", name).casefold()


def read_relationships(archive, part):
    root = _read_xml(archive, part)
    if root.tag != f"{{{RELS_NS}}}Relationships":
        raise ValueError(f"invalid relationships part: {part}")
    return root.findall(f"{{{RELS_NS}}}Relationship")


def _registrations(archive, entries, overrides, defaults):
    incoming = defaultdict(list)
    for name, entry in entries.items():
        path = PurePosixPath(name)
        if path.parent.name != "_rels" or not path.name.endswith(".rels"):
            continue
        owner = "" if name == "_rels/.rels" else str(
            path.parent.parent / path.name.removesuffix(".rels")
        )
        source = entries[owner].filename if owner in entries else owner
        for rel in read_relationships(archive, entry):
            target = relationship_target(owner, rel.attrib)
            if target in entries:
                incoming[target].append({
                    "source": source, "relationship_part": entry.filename,
                    "id": rel.get("Id"), "type": rel.get("Type"), "target": rel.get("Target"),
                })
    registrations = {}
    for name, entry in entries.items():
        extension = name.rpartition(".")[2]
        registrations[entry.filename] = {
            "content_type": overrides.get(name, defaults.get(extension)),
            "content_type_source": ("Override" if name in overrides
                                    else "Default" if extension in defaults else None),
            "relationships": sorted(incoming[name], key=lambda rel: (
                rel["relationship_part"], rel["id"] or "", rel["type"] or "", rel["target"] or "",
            )),
        }
    return registrations


def package_inventory(package: Path, *, include_registrations: bool = True) -> tuple[dict, dict]:
    parts = {}
    with zipfile.ZipFile(package) as archive:
        check_zip_members(archive)
        overrides, defaults = _content_types(archive)
        entries = {part_key(entry.filename): entry for entry in archive.infolist() if not entry.is_dir()}
        registrations = _registrations(archive, entries, overrides, defaults) if include_registrations else {}
        for name, entry in entries.items():
            extension = name.rpartition(".")[2]
            content_type = overrides.get(name, defaults.get(extension, "")).casefold()
            if name == "[content_types].xml" or not (
                extension in {"xml", "vml"} or content_type.endswith(("+xml", "/xml", ".vmldrawing"))
            ):
                continue
            counts = dict.fromkeys(FEATURES, 0)
            metadata = {COMMENT_METADATA_TYPES.get(content_type)}
            stack = []
            field_stories = [ComplexFieldScan()]
            historical_depth = 0
            with archive.open(entry) as source:
                for event, element in XML.iterparse(source, ("start", "end"), forbid_dtd=True):
                    tag = element.tag
                    if event == "start":
                        if not stack:
                            metadata.add(COMMENT_METADATA_ROOTS.get(tag))
                        stack.append(element)
                        if tag in STORY_OWNER_TAGS and len(stack) > 1:
                            field_stories.append(ComplexFieldScan())
                        if tag in PROPERTY_CHANGE_TAGS:
                            historical_depth += 1
                        if not historical_depth and (type_attr := FIELD_CHAR_TYPES.get(tag)):
                            field = field_stories[-1].delimiter(element.get(type_attr))
                            if field is not None:
                                _, _, issue = field
                                counts[MALFORMED_FIELDS if issue else BALANCED_FIELDS] += 1
                        continue
                    if kind := FEATURE_TAGS.get(tag):
                        counts[kind] += 1
                    if (not historical_depth and tag in PARAGRAPH_MATH_TAGS
                            and tuple(parent.tag for parent in stack[-4:]) in PARAGRAPH_MATH_PATHS):
                        counts["w:oMath"] += 1
                    if tag in PROPERTY_CHANGE_TAGS:
                        historical_depth -= 1
                    if tag in STORY_OWNER_TAGS or len(stack) == 1:
                        counts[MALFORMED_FIELDS] += sum(1 for _ in field_stories.pop().unclosed())
                    stack.pop()
                    if stack:
                        stack[-1].remove(element)
            for kind in metadata - {None}:
                counts[kind] = 1
            parts[entry.filename] = counts
    return parts, registrations


def inventory(package: Path) -> dict[str, dict[str, int]]:
    return package_inventory(package, include_registrations=False)[0]


def registration_changes(original, edited):
    return {
        "added": [dict(part=part, **edited[part]) for part in sorted(edited.keys() - original.keys())],
        "removed": [dict(part=part, **original[part]) for part in sorted(original.keys() - edited.keys())],
        "registration_changed": [
            dict(part=part, before=original[part], after=edited[part])
            for part in sorted(original.keys() & edited.keys()) if original[part] != edited[part]
        ],
    }


def compare(original, edited, allowed: dict[str, int]) -> dict:
    changes = []
    problems = []
    # Track losses and gains separately so a gain in one part cannot hide a
    # loss of the same element in another part.
    deltas = Counter()
    for part in sorted(original.keys() | edited.keys()):
        for kind in FEATURES:
            before = original.get(part, {}).get(kind, 0)
            after = edited.get(part, {}).get(kind, 0)
            delta = after - before
            if delta:
                changes.append({"part": part, "kind": kind, "before": before,
                                "after": after, "delta": delta})
                if kind == MALFORMED_FIELDS and delta > 0:
                    problems.append({"part": part, "kind": kind, "gain": delta})
                deltas[kind, delta < 0] += delta
    for kind in FEATURES:
        if kind == MALFORMED_FIELDS:
            continue
        loss = deltas[kind, True]
        expected = allowed.get(kind)
        if loss < 0 and (expected is None or expected >= 0):
            problems.append({"kind": kind, "loss": loss})
        if expected is not None:
            actual = deltas[kind, expected < 0]
            if actual != expected:
                problems.append({"kind": kind, "expected": expected, "actual": actual})
    return {"ok": not problems, "changes": changes, "allowed": allowed, "problems": problems}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, nargs="?", help="inventory this Word package")
    parser.add_argument("--compare", nargs=2, type=Path, metavar=("ORIGINAL", "EDITED"),
                        help="report per-part deltas and fail on unexpected losses or new malformed fields")
    parser.add_argument("--allow", action="append", default=[], metavar="KIND=DELTA",
                        help="expect an exact signed loss or gain of a feature across parts, repeatable")
    args = parser.parse_args()
    if bool(args.package) == bool(args.compare) or (args.allow and not args.compare):
        parser.error("provide a package or --compare ORIGINAL EDITED, with --allow only for comparisons")

    allowed = {}
    for item in args.allow:
        name, _, value = item.partition("=")
        kind = FEATURE_NAMES.get(name, name)
        try:
            delta = int(value)
        except ValueError:
            parser.error(f"expected KIND=DELTA, got {item!r}")
        if kind == MALFORMED_FIELDS or kind not in FEATURES or kind in allowed or delta == 0:
            parser.error(f"expected a unique feature kind and a nonzero delta, got {item!r}")
        allowed[kind] = delta
    try:
        if args.compare:
            original, edited = args.compare
            before, before_registrations = package_inventory(original)
            after, after_registrations = package_inventory(edited)
            result = compare(before, after, allowed)
            result["part_changes"] = registration_changes(before_registrations, after_registrations)
        else:
            parts, registrations = package_inventory(args.package)
            result = {"ok": True, "parts": parts, "registrations": registrations}
    except (OSError, ValueError, RuntimeError, KeyError, NotImplementedError, zipfile.BadZipFile,
            XML.ParseError, DefusedXmlException) as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
