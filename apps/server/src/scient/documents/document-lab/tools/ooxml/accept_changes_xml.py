"""Accept or reject tracked changes in Word story XML. Report results as JSON."""

import argparse
from collections import Counter, defaultdict
from copy import copy
import json
import lzma
import os
from pathlib import Path
import shutil
import tempfile
import zipfile
import zlib

from lxml import etree as XML

from docx_feature_inventory import (
    CONTENT_TYPES_NS, DELETED_TEXT, MOVE_MARKERS, MOVES, PROPERTY_CHANGES,
    STORY_OWNER_NAMES, STRICT_WORD_NS,
    SUPPORTED_REVISIONS, UNSUPPORTED_REVISIONS, WORD_2010_NS, WORD_CONFLICTS,
    WORD_CONTENT_TYPE, WORD_NS, ComplexFieldScan, check_zip_members, part_key,
)


# Content types also locate story parts whose names differ from Word's defaults.
STORY_TYPES = {
    f"{WORD_CONTENT_TYPE}{kind}+xml": root
    for kind, root in {
        "document.main": "document", "header": "hdr", "footer": "ftr",
        "footnotes": "footnotes", "endnotes": "endnotes", "comments": "comments",
    }.items()
}
STORY_ROOTS = set(STORY_TYPES.values())
PARAGRAPH_MARK_REVISIONS = {"ins", "del", "moveFrom", "moveTo"}
TRAILING_PROPERTY_METADATA = {
    "pPr": {"rPr", "sectPr"},
    "trPr": {"ins", "del"},
    "tcPr": {"cellIns", "cellDel", "cellMerge"},
}
# Section properties are an ordered sequence. Word treats the saved values
# as an overlay on the current section, which also owns its header/footer refs.
SECTION_ORDER = (
    "headerReference", "footerReference", "footnotePr", "endnotePr", "type", "pgSz",
    "pgMar", "paperSrc", "pgBorders", "lnNumType", "pgNumType", "cols", "formProt",
    "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid",
    "printerSettings", "sectPrChange",
)
ANCHOR_FAMILIES = (
    ("bookmarkStart", "bookmarkEnd"),
    ("commentRangeStart", "commentRangeEnd", "commentReference"),
)
WORD_2010 = f"{{{WORD_2010_NS}}}"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
INHERITED_XML = ("space", "lang", "base")


class UnsupportedRevision(Exception):
    def __init__(self, kind, reason):
        self.kind = kind
        self.reason = reason


def parse_xml(data):
    parser = XML.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    tree = XML.fromstring(data, parser).getroottree()
    if tree.docinfo.doctype:
        raise ValueError("DTDs are forbidden in package XML")
    return tree


def revision_kind(element, w):
    tag = element.tag
    if not isinstance(tag, str):
        return None
    if tag.startswith(w):
        kind = tag[len(w):]
        if kind in SUPPORTED_REVISIONS or kind in UNSUPPORTED_REVISIONS:
            return f"w:{kind}"
    if tag.startswith(WORD_2010) and tag[len(WORD_2010):] in WORD_CONFLICTS:
        return f"w14:{tag[len(WORD_2010):]}"
    return None


def discard(element):
    """Keep XML whitespace following a node that is being removed."""
    if element.tail:
        previous = element.getprevious()
        if previous is not None:
            previous.tail = (previous.tail or "") + element.tail
        else:
            parent = element.getparent()
            parent.text = (parent.text or "") + element.tail
    element.getparent().remove(element)


def xml_context(element, attribute):
    name = f"{{http://www.w3.org/XML/1998/namespace}}{attribute}"
    while element is not None:
        if name in element.attrib:
            return element.get(name)
        element = element.getparent()
    return None


def check_reparent(source, destination, kind):
    # Moving a node out of scope can invalidate QName-valued MC attributes
    # or change inherited XML space, language, or base URI.
    scope = destination.nsmap
    if (any(scope.get(prefix) != uri for prefix, uri in source.nsmap.items()) or
            any(xml_context(source, attr) != xml_context(destination, attr)
                for attr in INHERITED_XML)):
        raise UnsupportedRevision(kind, "moving content would change its XML scope")


def unwrap(element, kind):
    parent = element.getparent()
    if len(element):
        check_reparent(element, parent, kind)
    if element.text and element.text.strip():
        raise UnsupportedRevision(kind, "unexpected text outside a run")
    for child in list(element):
        element.addprevious(child)
    discard(element)


class Story:
    def __init__(self, root, w, accept, author):
        self.root = root
        self.w = w
        self.accept = accept
        self.author = author
        self.joins = {}
        self.tables = defaultdict(dict)
        self.moves_selected = set()
        self.revisions = {
            node: kind for node in root.iter() if (kind := revision_kind(node, w))
        }
        self.property_tags = {w + prop for prop in PROPERTY_CHANGES.values()}
        self.deleted_tags = {w + name for name in DELETED_TEXT}
        self.story_owners = {w + name for name in STORY_OWNER_NAMES}

    def selected(self, node):
        return self.author is None or node.get(self.w + "author") == self.author

    def structural_marker(self, node, kind):
        w = self.w
        parent = node.getparent()
        name = kind[2:]
        if name in {"cellIns", "cellDel"}:
            return True
        if name not in PARAGRAPH_MARK_REVISIONS:
            return False
        return parent.tag == w + "trPr" or (
            parent.tag == w + "rPr" and parent.getparent().tag == w + "pPr"
        )

    def historical(self, node):
        return any(self.revisions.get(parent, "")[2:] in PROPERTY_CHANGES
                   for parent in node.iterancestors())

    def attached(self, node):
        return any(parent is self.root for parent in node.iterancestors())

    def owner(self, node):
        return next((p for p in node.iterancestors() if p.tag in self.story_owners), self.root)

    def anchors(self, family):
        found = defaultdict(Counter)
        for node in self.root.iter(*(self.w + name for name in family)):
            found[self.owner(node), node.get(self.w + "id")][node.tag] += 1
        return found

    def field_structure(self):
        scans = defaultdict(ComplexFieldScan)
        fields = set()
        for node in self.root.iter(self.w + "fldChar"):
            if not self.historical(node):
                owner = self.owner(node)
                field = scans[owner].delimiter(node.get(self.w + "fldCharType"), node)
                if field is not None:
                    fields.add((owner, *field))
        fields.update((owner, *field) for owner, scan in scans.items() for field in scan.unclosed())
        return fields

    def move_groups(self, active):
        """Match each range end by id and link source and destination by name."""
        open_ranges = {}
        seen_ids = set()
        groups = defaultdict(dict)
        for node, kind in active.items():
            name = kind[2:]
            if name not in MOVES and name not in MOVE_MARKERS:
                continue
            story = self.owner(node)
            side = "moveFrom" if name.startswith("moveFrom") else "moveTo"
            key = (story, side)
            if name.endswith("Start"):
                move_name = node.get(self.w + "name")
                move_id = node.get(self.w + "id")
                if (key in open_ranges or not move_name or side in groups[move_name]
                        or not move_id or (story, move_id) in seen_ids):
                    raise UnsupportedRevision(kind, "overlapping or unnamed move range")
                seen_ids.add((story, move_id))
                group = groups[move_name][side] = [node]
                open_ranges[key] = group
            elif name.endswith("End"):
                group = open_ranges.pop(key, None)
                if (group is None or not node.get(self.w + "id")
                        or node.get(self.w + "id") != group[0].get(self.w + "id")):
                    raise UnsupportedRevision(kind, "unmatched move range end")
                group.append(node)
            elif key in open_ranges:
                open_ranges[key].append(node)
            elif self.selected(node):
                raise UnsupportedRevision(kind, "move content has no enclosing move range")
        if open_ranges:
            raise UnsupportedRevision("w:move", "unclosed move range")
        for sides in groups.values():
            nodes = [node for side in sides.values() for node in side]
            if not any(self.selected(node) for node in nodes if not active[node].endswith("End")):
                continue
            if sides.keys() != MOVES or any(len(side) < 3 for side in sides.values()):
                raise UnsupportedRevision("w:move", "named move lacks source or destination content")
            if any(not self.selected(node) for node in nodes if not active[node].endswith("End")):
                raise UnsupportedRevision("w:move", "author filter would resolve only part of a move")
            self.moves_selected.update(nodes)

    def restore_properties(self, node, kind):
        w = self.w
        prop = PROPERTY_CHANGES[kind[2:]]
        current = node.getparent()
        if current.tag != w + prop or len(node) != 1 or node[0].tag != current.tag:
            if prop == "sectPr" and current.tag == w + prop and not len(node):
                raise UnsupportedRevision(kind, "the previous section properties are absent")
            raise UnsupportedRevision(kind, "expected a previous-property snapshot")
        old = node[0]
        check_reparent(old, current, kind)
        if prop == "sectPr":
            self.restore_section(node, old, kind)
            return
        # Restore formatting independently of the live structural markers and math flag.
        # Paragraph-mark markers precede the base properties. Cell and row
        # markers follow them. A snapshot can contain historical copies.
        leading = set()
        trailing = {w + name for name in TRAILING_PROPERTY_METADATA.get(prop, ())}
        if prop == "rPr" and current.getparent().tag == w + "pPr":
            leading = {w + name for name in PARAGRAPH_MARK_REVISIONS}
            trailing.add(w + "oMath")
        keep = leading | trailing
        for child in list(current):
            if child.tag not in keep:
                discard(child)
        restored = [child for child in old if child.tag not in keep]
        offset = sum(child.tag in leading for child in current)
        for index, child in enumerate(restored, start=offset):
            current.insert(index, child)

    def restore_section(self, node, old, kind):
        current = node.getparent()
        rank = {self.w + name: i for i, name in enumerate(SECTION_ORDER)}
        for child in list(old):
            if child.tag not in rank or child.tag in {
                self.w + name for name in ("headerReference", "footerReference", "sectPrChange")
            }:
                raise UnsupportedRevision(kind, "unexpected previous section property")
            present = current.find(child.tag)
            if present is not None:
                child.tail = (child.tail or "") + (present.tail or "")
                current.replace(present, child)
            else:
                following = next(el for el in current if rank.get(el.tag, -1) > rank[child.tag])
                following.addprevious(child)
        for key, value in old.attrib.items():
            current.set(key, value)
        discard(node)

    def restore_listnum(self, node, kind):
        w = self.w
        field = node.getparent()
        run = field.getparent()
        original = node.get(w + "original")
        if (original is None or field.get(w + "fldCharType") != "begin"
                or run.tag != w + "r" or run.getparent().tag != w + "p"
                or [el for el in run if el.tag != w + "rPr"] != [field]):
            raise UnsupportedRevision(kind, "LISTNUM needs a previous value and a simple field")
        instructions = []
        result = []
        separated = False
        for sibling in run.itersiblings():
            if sibling.tag != w + "r":
                break
            children = [child for child in sibling if child.tag != w + "rPr"]
            if len(children) != 1:
                break
            child = children[0]
            if child.tag == w + "instrText" and not separated:
                instructions.append(child.text or "")
            elif child.tag == w + "t" and separated:
                result.append(child)
            elif child.tag == w + "fldChar" and not len(child):
                field_type = child.get(w + "fldCharType")
                if field_type == "separate" and not separated:
                    separated = True
                elif field_type == "end":
                    instruction = "".join(instructions).strip().split()
                    if instruction and instruction[0].upper() == "LISTNUM" and len(result) == 1:
                        result[0].text = original
                        if original != original.strip():
                            result[0].set(XML_SPACE, "preserve")
                        discard(node)
                        return
                    break
                else:
                    break
            else:
                break
        raise UnsupportedRevision(kind, "could not identify a single cached LISTNUM result")

    def numbering(self, node, kind):
        w = self.w
        parent = node.getparent()
        if parent.tag not in {w + "numPr", w + "fldChar"}:
            raise UnsupportedRevision(kind, "unexpected numbering revision location")
        if self.accept:
            discard(node)
        elif parent.tag == w + "fldChar":
            self.restore_listnum(node, kind)
        else:
            change = parent.getparent().find(w + "pPrChange")
            insertion = parent.find(w + "ins")
            if ((change is not None and change in self.revisions and self.selected(change))
                    or (insertion is not None and self.selected(insertion))):
                # The enclosing rejection restores or removes the entire numPr.
                return
            raise UnsupportedRevision(kind, "w:original alone does not identify the old list binding")

    def decide_content(self, node, name, kind):
        w = self.w
        parent = node.getparent()
        owner = parent.getparent()
        removes_content = (name in {"del", "moveFrom"}) == self.accept
        if parent.tag in self.property_tags or parent.tag == w + "numPr":
            if len(node) or (node.text and node.text.strip()):
                raise UnsupportedRevision(kind, "a property revision marker contains content")
            if parent.tag == w + "rPr" and owner is not None and owner.tag == w + "pPr":
                paragraph = owner.getparent()
                if paragraph is None or paragraph.tag != w + "p":
                    raise UnsupportedRevision(kind, "paragraph-mark revision outside a paragraph")
                if removes_content:
                    self.joins[paragraph] = kind
            elif (parent.tag == w + "trPr" and owner is not None
                  and owner.tag == w + "tr" and name in {"ins", "del"}):
                if removes_content:
                    self.drop_table_item(owner, kind)
                    return
            elif parent.tag == w + "numPr" and name == "ins":
                if removes_content:
                    discard(parent)
                    return
            else:
                raise UnsupportedRevision(kind, "unexpected revision marker in properties")
            discard(node)
        elif parent.tag == w + "r" or parent.tag.endswith("}ctrlPr"):
            raise UnsupportedRevision(kind, "run or math control properties encode a separate revision")
        elif removes_content:
            discard(node)
        else:
            unwrap(node, kind)

    def drop_table_item(self, node, kind):
        w = self.w
        row = node if node.tag == w + "tr" else next(node.iterancestors(w + "tr"), None)
        table = next(node.iterancestors(w + "tbl"), None)
        if table is None or row is None:
            raise UnsupportedRevision(kind, "table revision outside a table row")
        # Deleting a merge restart or shifting a horizontally merged cell
        # can change the scope of a different marker.
        if next(row.iter(w + "vMerge", w + "hMerge"), None) is not None:
            raise UnsupportedRevision(kind, "table removal would affect a row with merged cells")
        self.tables[table][row] = kind
        discard(node)

    def apply(self, node, kind):
        w = self.w
        name = kind[2:]
        if name in MOVE_MARKERS:
            discard(node)
        elif name in PROPERTY_CHANGES:
            if self.accept:
                discard(node)
            else:
                self.restore_properties(node, kind)
        elif name == "numberingChange":
            self.numbering(node, kind)
        elif name in {"cellIns", "cellDel"}:
            parent = node.getparent()
            if parent.tag != w + "tcPr" or parent.getparent().tag != w + "tc" or len(node):
                raise UnsupportedRevision(kind, "cell revision outside cell properties")
            if (name == "cellDel") == self.accept:
                self.drop_table_item(parent.getparent(), kind)
            else:
                discard(node)
        else:
            self.decide_content(node, name, kind)

    def join_paragraphs(self):
        w = self.w
        # Right to left keeps the identity and properties of the last paragraph
        # in a chain, including IDs used by modern comment metadata.
        for paragraph in reversed(list(self.root.iter(w + "p"))):
            if paragraph not in self.joins:
                continue
            kind = self.joins[paragraph]
            following = paragraph.getnext()
            # XML comments and range markers can sit between sibling paragraphs.
            while following is not None and (
                not isinstance(following.tag, str) or following.tag in {
                    w + "bookmarkStart", w + "bookmarkEnd", w + "commentRangeStart",
                    w + "commentRangeEnd", w + "permStart", w + "permEnd",
                }
            ):
                following = following.getnext()
            if following is None or following.tag != w + "p":
                raise UnsupportedRevision(kind, "removed paragraph mark has no following sibling paragraph")
            properties = paragraph.find(w + "pPr")
            if properties is not None and properties.find(w + "sectPr") is not None:
                raise UnsupportedRevision(kind, "removed paragraph mark carries a section break")
            check_reparent(paragraph, following, kind)
            children = [child for child in paragraph if child is not properties]
            sibling = paragraph.getnext()
            while sibling is not following:
                children.append(sibling)
                sibling = sibling.getnext()
            offset = int(following.find(w + "pPr") is not None)
            for index, child in enumerate(children, offset):
                following.insert(index, child)
            discard(paragraph)

    def check_tables(self):
        w = self.w
        for table, rows in self.tables.items():
            if not self.attached(table):
                continue
            if next(table.iter(w + "tr"), None) is None:
                if any(child.tag not in {w + "tblPr", w + "tblGrid"} for child in table):
                    kind = next(iter(rows.values()))
                    raise UnsupportedRevision(kind, "empty table still contains other markup")
                discard(table)
            for row, kind in rows.items():
                if self.attached(row) and next(row.iter(w + "tc"), None) is None:
                    raise UnsupportedRevision(kind, "removal would leave a row without cells")

    def resolve(self, is_story):
        active = {n: kind for n, kind in self.revisions.items() if not self.historical(n)}
        issues = []
        for node, kind in active.items():
            # Unknown author on a construct such as tblGridChange cannot
            # establish that the revision is outside an author-filtered edit.
            if self.author is not None and node.get(self.w + "author") not in (None, self.author):
                continue
            if not is_story or not kind.startswith("w:") or kind[2:] not in SUPPORTED_REVISIONS:
                reason = ("revision outside the supported Word stories" if not is_story
                          else "revision kind has no implemented Word semantics")
                issues.append((kind, reason))
        if issues:
            return issues

        self.move_groups(active)
        selected = {
            n for n, kind in active.items()
            if kind[2:] not in DELETED_TEXT and (
                n in self.moves_selected if kind[2:] in MOVE_MARKERS else self.selected(n)
            )
        }
        # The nearest deleting wrapper supplies the deleted run's author.
        deleted = {}
        for node, kind in active.items():
            if kind[2:] in DELETED_TEXT:
                owner = next((p for p in node.iterancestors()
                              if p.tag in {self.w + "del", self.w + "moveFrom"}), None)
                if owner is None:
                    issues.append((kind, "deleted run text has no deletion or move source"))
                elif owner in selected:
                    deleted[node] = kind
        if issues:
            return issues
        if not selected:
            return []
        anchors_before = [self.anchors(family) for family in ANCHOR_FAMILIES]
        fields_before = self.field_structure()
        # Resolve structural markers against the live paragraph and table
        # properties, before any restoration can change their geometry.
        pending = [(node, kind) for node, kind in reversed(active.items()) if node in selected]
        pending.sort(key=lambda item: not self.structural_marker(*item))
        for node, kind in pending:
            if self.attached(node):
                self.apply(node, kind)
        self.check_tables()
        self.join_paragraphs()

        for node in self.root.iter(*self.deleted_tags):
            if node in deleted and not any(p.tag in {self.w + "del", self.w + "moveFrom"}
                                            for p in node.iterancestors()):
                node.tag = self.w + DELETED_TEXT[deleted[node][2:]]

        for family, before in zip(ANCHOR_FAMILIES, anchors_before):
            for key, markers in self.anchors(family).items():
                if before[key] != markers:
                    issues.append((f"w:{family[0]}", f"edit would leave a partial anchor (w:id={key[1]})"))
        # Complete fields may disappear. Every surviving group must keep
        # its exact delimiters and nesting in the same story.
        for _, _, _, issue in self.field_structure() - fields_before:
            reason = (f"edit would leave a malformed complex field ({issue})" if issue
                      else "edit would change the delimiters or nesting of a surviving complex field")
            issues.append(("w:fldChar", reason))

        remaining = {n: kind for n in self.root.iter() if (kind := revision_kind(n, self.w))}
        selected.update(deleted)
        if self.author is not None:
            for node in active.keys() - remaining.keys() - selected:
                issues.append((active[node], "edit would discard another author's revision"))
        for node in selected & remaining.keys():
            issues.append((remaining[node], "revision could not be resolved independently"))
        for node in remaining.keys() - active.keys():
            if not self.historical(node) and (self.selected(node) or node.get(self.w + "author") is None):
                issues.append((remaining[node], "restoring prior properties would expose a historical revision"))
        return issues


def story_parts(package):
    wml = f"{{{CONTENT_TYPES_NS}}}"
    manifest = parse_xml(package.read("[Content_Types].xml")).getroot()
    if manifest.tag != wml + "Types":
        raise ValueError("invalid [Content_Types].xml root")
    overrides = {}
    for override in manifest.findall(wml + "Override"):
        name = part_key(override.attrib["PartName"].removeprefix("/"))
        if name in overrides:
            raise ValueError(f"duplicate content type for {name}")
        overrides[name] = override.attrib["ContentType"].casefold()
    defaults = {e.attrib["Extension"].casefold(): e.attrib["ContentType"].casefold()
                for e in manifest.findall(wml + "Default")}
    for entry in package.infolist():
        if entry.is_dir():
            continue
        key = part_key(entry.filename)
        extension = key.rpartition(".")[2]
        content_type = overrides.get(key, defaults.get(extension, ""))
        if content_type.startswith(WORD_CONTENT_TYPE) or (
            key.startswith("word/") and extension == "xml"
        ):
            yield entry, STORY_TYPES.get(content_type)


def process_package(package, args, report):
    check_zip_members(package)
    changes = {}
    found_main = False
    for entry, expected_root in story_parts(package):
        tree = parse_xml(package.read(entry))
        root = tree.getroot()
        qname = XML.QName(root)
        if expected_root and (qname.namespace not in (WORD_NS, STRICT_WORD_NS)
                              or qname.localname != expected_root):
            raise ValueError(f"invalid {expected_root} root in {entry.filename}")
        if qname.namespace not in (WORD_NS, STRICT_WORD_NS):
            continue
        is_story = qname.localname in STORY_ROOTS
        if qname.localname == "document":
            if found_main:
                raise ValueError("multiple Word main document parts found")
            found_main = True
        story = Story(root, f"{{{qname.namespace}}}", args.mode == "accept", args.author)
        if not story.revisions:
            continue
        before = Counter(story.revisions.values())
        report["counts"].update(before)
        try:
            issues = story.resolve(is_story)
        except UnsupportedRevision as error:
            issues = [(error.kind, error.reason)]
        for (kind, reason), count in Counter(issues).items():
            report["unsupported"].append(dict(part=entry.filename, kind=kind, reason=reason, count=count))
        if issues:
            continue
        after = Counter(kind for n in root.iter() if (kind := revision_kind(n, story.w)))
        if before != after:
            changes[entry.filename] = XML.tostring(tree, encoding="UTF-8", xml_declaration=True)
            report["resolved"].update(before - after)
    if not found_main:
        raise ValueError("no Word main document part found")
    return changes


def write_output(source, package, output, changes):
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as staging:
        path = Path(staging) / "revised.docx"
        if not changes:
            shutil.copyfile(source, path)
        else:
            with zipfile.ZipFile(path, "w") as result:
                result.comment = package.comment
                for entry in package.infolist():
                    if entry.filename in changes:
                        result.writestr(copy(entry), changes[entry.filename])
                    else:
                        with package.open(entry) as part, result.open(copy(entry), "w") as dest:
                            shutil.copyfileobj(part, dest)
        os.replace(path, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="original DOCX")
    parser.add_argument("-o", "--output", required=True, type=Path, help="separate output DOCX")
    parser.add_argument("--mode", choices=("accept", "reject"), default="accept")
    parser.add_argument("--author", help="resolve only revisions with this author name")
    args = parser.parse_args()
    report = dict(ok=False, mode=args.mode, author=args.author, counts=Counter(),
                  resolved=Counter(), unsupported=[], changed_parts=[])
    try:
        if args.input.resolve() == args.output.resolve():
            raise ValueError("input and output must be different files")
        with zipfile.ZipFile(args.input) as package:
            changes = process_package(package, args, report)
            if not report["unsupported"]:
                write_output(args.input, package, args.output, changes)
                report.update(ok=True, output=str(args.output), changed_parts=sorted(changes))
    except (OSError, ValueError, RuntimeError, KeyError, EOFError,
            zipfile.BadZipFile, XML.XMLSyntaxError, zlib.error, lzma.LZMAError) as error:
        report["error"] = str(error)
    if not report["ok"]:
        report["resolved"].clear()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
