# Modified by Scient lab 2026-11-22: resolve comment parts by relationship and verify saved replies.
"""Add comments to a DOCX document.

Accepts either an unpacked directory OR a .docx/.dotx file directly.

Usage:
    # Against an unpacked directory (writes satellite files in place)
    python comment.py unpacked/ "Comment text"
    python comment.py unpacked/ "Reply text" --parent 0

    # Against a .docx directly (extracts, writes satellite files, rezips)
    python comment.py contract.docx "This cap is too low" -o annotated.docx
    python comment.py contract.docx "Comment" --id 5      # explicit ID

The comment ID is auto-assigned (max existing + 1) unless --id is given.
Plain text is XML-escaped automatically; if you pass already-escaped text
(e.g. &amp;, &#x2019;) use --raw to skip escaping.
For a reply, the last paragraph of the parent comment must have a
`w14:paraId` so the helper can link the thread.

After running, add markers to the target story so the comment is visible:
  <w:commentRangeStart w:id="N"/>
  ... commented content ...
  <w:commentRangeEnd w:id="N"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="N"/></w:r>
"""

import argparse
import os
import random
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote

import defusedxml.minidom
from defusedxml.common import DefusedXmlException
from xml.parsers.expat import ExpatError
from xml.sax.saxutils import escape as xml_escape

from docx_feature_inventory import (
    CONTENT_TYPES_NS, RELS_NS, STRICT_RELS, STRICT_WORD_NS, TRANSITIONAL_RELS,
    WORD_CONTENT_TYPE, WORD_NS, check_entry_budget, check_zip_members, part_key,
    relationships_path,
)
from office.helpers import opc_target, rezip as _rezip, safe_extract as _safe_extract

TEMPLATE_DIR = Path(__file__).parent / "templates"
NS = {
    "w": WORD_NS,
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16cid": "http://schemas.microsoft.com/office/word/2016/wordml/cid",
    "w16cex": "http://schemas.microsoft.com/office/word/2018/wordml/cex",
}

COMMENT_XML = """\
<w:comment w:id="{id}" w:author="{author}" w:date="{date}" w:initials="{initials}">
  <w:p w14:paraId="{para_id}" w14:textId="77777777">
    <w:r>
      <w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>
      <w:annotationRef/>
    </w:r>
    <w:r>
      <w:rPr>
        <w:color w:val="000000"/>
        <w:sz w:val="20"/>
        <w:szCs w:val="20"/>
      </w:rPr>
      <w:t xml:space="preserve">{text}</w:t>
    </w:r>
  </w:p>
</w:comment>"""

COMMENT_MARKER_TEMPLATE = """
Add to the target story (markers must be direct children of w:p, never inside w:r):
  <w:commentRangeStart w:id="{cid}"/>
  <w:r>...</w:r>
  <w:commentRangeEnd w:id="{cid}"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{cid}"/></w:r>"""

REPLY_MARKER_TEMPLATE = """
Nest markers inside parent {pid}'s markers (direct children of w:p, never inside w:r):
  <w:commentRangeStart w:id="{pid}"/><w:commentRangeStart w:id="{cid}"/>
  <w:r>...</w:r>
  <w:commentRangeEnd w:id="{cid}"/><w:commentRangeEnd w:id="{pid}"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{pid}"/></w:r>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{cid}"/></w:r>"""

SMART_QUOTE_ENTITIES = {
    "“": "&#x201C;",
    "”": "&#x201D;",
    "‘": "&#x2018;",
    "’": "&#x2019;",
}
ATTRIBUTE_ESCAPES = {'"': "&quot;"}


def _generate_hex_id() -> str:
    return f"{random.randint(1, 0x7FFFFFFE):08X}"


def _encode_smart_quotes(text: str) -> str:
    for char, entity in SMART_QUOTE_ENTITIES.items():
        text = text.replace(char, entity)
    return text


XMLNS_NS = "http://www.w3.org/2000/xmlns/"
COMMENT_PARTS = (
    ("comments", None),
    ("commentsExtended", "http://schemas.microsoft.com/office/2011/relationships"),
    ("commentsIds", "http://schemas.microsoft.com/office/2016/09/relationships"),
    ("commentsExtensible", "http://schemas.microsoft.com/office/2018/08/relationships"),
)


def _parse(data: bytes):
    return defusedxml.minidom.parseString(data, forbid_dtd=True)


def _append_xml(data: bytes, root_tag: str, content: str, namespaces: dict) -> bytes:
    dom = _parse(data)
    prefix, local_name = root_tag.split(":")
    root = dom.documentElement
    if (root.namespaceURI, root.localName) != (namespaces[prefix], local_name):
        raise ValueError(f"expected comment part root {root_tag}, found {root.tagName}")
    ns_attrs = " ".join(f'xmlns:{k}="{v}"' for k, v in namespaces.items())
    wrapper = _parse(f"<root {ns_attrs}>{content}</root>".encode())
    for child in wrapper.documentElement.childNodes:
        if child.nodeType == child.ELEMENT_NODE:
            node = dom.importNode(child, True)
            for key, uri in namespaces.items():
                if root.getAttributeNS(XMLNS_NS, key) != uri and not node.hasAttributeNS(XMLNS_NS, key):
                    node.setAttributeNS(XMLNS_NS, f"xmlns:{key}", uri)
            root.appendChild(node)
    return _encode_smart_quotes(dom.toxml(encoding="UTF-8").decode()).encode()


def _comments_by_id(data: bytes, word_ns: str) -> dict[int, object]:
    comments = {}
    for comment in _parse(data).getElementsByTagNameNS(word_ns, "comment"):
        cid = int(comment.getAttributeNS(word_ns, "id"))
        if cid in comments:
            raise ValueError(f"duplicate comment ID {cid}")
        comments[cid] = comment
    return comments


def _last_para_id(comment, word_ns: str) -> str:
    paragraphs = comment.getElementsByTagNameNS(word_ns, "p")
    return paragraphs[-1].getAttributeNS(NS["w14"], "paraId") if paragraphs else ""


def _rel_target(rel, owner: str) -> str:
    part = opc_target(rel.getAttribute("Target"), owner, rel.getAttribute("TargetMode"))
    if part is None:
        raise ValueError(f"expected an internal part for {rel.getAttribute('Type')}")
    return part


def _resolve_comment_parts(read, *, create: bool = False):
    root_rels = _parse(read("_rels/.rels"))
    office_rels = [
        rel for rel in root_rels.getElementsByTagNameNS(RELS_NS, "Relationship")
        if rel.getAttribute("Type") in {f"{base}/officeDocument" for base in (TRANSITIONAL_RELS, STRICT_RELS)}
    ]
    if len(office_rels) != 1:
        raise ValueError("expected exactly one officeDocument relationship")
    base = office_rels[0].getAttribute("Type").removesuffix("/officeDocument")
    word_ns = STRICT_WORD_NS if base == STRICT_RELS else WORD_NS
    main = PurePosixPath(_rel_target(office_rels[0], ""))
    rels_path = relationships_path(str(main))
    try:
        rels = _parse(read(rels_path))
    except (FileNotFoundError, KeyError):
        if not create:
            raise
        rels = _parse(f'<Relationships xmlns="{RELS_NS}"/>'.encode())
    root = rels.documentElement
    if (root.namespaceURI, root.localName) != (RELS_NS, "Relationships"):
        raise ValueError(f"invalid relationships part: {rels_path}")
    entries = rels.getElementsByTagNameNS(RELS_NS, "Relationship")
    ids = {rel.getAttribute("Id") for rel in entries}
    next_rid = 1
    parts, new_parts = {}, set()

    for name, rel_base in COMMENT_PARTS:
        rel_type = f"{rel_base or base}/{name}"
        matches = [rel for rel in entries if rel.getAttribute("Type") == rel_type]
        if len(matches) > 1:
            raise ValueError(f"duplicate {name} relationship")
        if matches:
            parts[name] = _rel_target(matches[0], str(main))
            continue
        if not create:
            raise ValueError(f"missing {name} relationship")
        target = f"{name}.xml"
        parts[name] = str(main.parent / target)
        new_parts.add(name)
        while f"rId{next_rid}" in ids:
            next_rid += 1
        qualified = f"{root.prefix}:Relationship" if root.prefix else "Relationship"
        rel = rels.createElementNS(RELS_NS, qualified)
        rel.setAttribute("Id", f"rId{next_rid}")
        rel.setAttribute("Type", rel_type)
        rel.setAttribute("Target", target)
        root.appendChild(rel)
        next_rid += 1

    if len({part_key(quote(part, safe="/")) for part in parts.values()}) != len(parts):
        raise ValueError("multiple comment relationships target the same part")
    return rels_path, rels, parts, new_parts, word_ns


def _comment_content_types(data: bytes, parts: dict[str, str]) -> bytes | None:
    dom = _parse(data)
    root = dom.documentElement
    if (root.namespaceURI, root.localName) != (CONTENT_TYPES_NS, "Types"):
        raise ValueError("invalid [Content_Types].xml root")
    existing = {
        part_key(o.getAttribute("PartName")): o.getAttribute("ContentType")
        for o in dom.getElementsByTagNameNS(CONTENT_TYPES_NS, "Override")
    }
    changed = False
    for name, part in parts.items():
        part_name = f"/{part}"
        encoded = quote(part_name, safe="/")
        key = part_key(encoded)
        content_type = f"{WORD_CONTENT_TYPE}{name}+xml"
        if key in existing:
            if existing[key] != content_type:
                raise ValueError(f"unexpected comment content type for {part_name}")
            continue
        qualified = f"{root.prefix}:Override" if root.prefix else "Override"
        override = dom.createElementNS(CONTENT_TYPES_NS, qualified)
        override.setAttribute("PartName", encoded)
        override.setAttribute("ContentType", content_type)
        root.appendChild(override)
        changed = True
    return dom.toxml(encoding="UTF-8") if changed else None


def _verify_saved_comment(read, comment_id: int, para_id: str, parent_id: int | None) -> None:
    _, _, parts, _, word_ns = _resolve_comment_parts(read)
    comments = _comments_by_id(read(parts["comments"]), word_ns)
    if comment_id not in comments or _last_para_id(comments[comment_id], word_ns) != para_id:
        raise ValueError(f"saved comment {comment_id} has an unexpected paraId")
    parent_para = _last_para_id(comments[parent_id], word_ns) if parent_id is not None else ""

    extensions = _parse(read(parts["commentsExtended"])).getElementsByTagNameNS(NS["w15"], "commentEx")
    matches = [ext for ext in extensions if ext.getAttributeNS(NS["w15"], "paraId") == para_id]
    if (len(matches) != 1 or (parent_id is not None and not parent_para)
            or matches[0].getAttributeNS(NS["w15"], "paraIdParent") != parent_para):
        raise ValueError(f"saved comment {comment_id} has an unexpected thread parent")

    ids = _parse(read(parts["commentsIds"])).getElementsByTagNameNS(NS["w16cid"], "commentId")
    durable_ids = [
        node.getAttributeNS(NS["w16cid"], "durableId")
        for node in ids if node.getAttributeNS(NS["w16cid"], "paraId") == para_id
    ]
    records = _parse(read(parts["commentsExtensible"])).getElementsByTagNameNS(
        NS["w16cex"], "commentExtensible",
    )
    if (len(durable_ids) != 1 or not durable_ids[0] or sum(
        node.getAttributeNS(NS["w16cex"], "durableId") == durable_ids[0] for node in records
    ) != 1):
        raise ValueError(f"saved comment {comment_id} has an unexpected durable ID")


def _check_directory(unpacked_dir: Path) -> dict[str, Path]:
    entries = {}

    def entry_sizes():
        for entry in unpacked_dir.rglob("*"):
            if entry.is_symlink() or not (entry.is_dir() or entry.is_file()):
                raise ValueError(f"unsafe unpacked entry: {entry}")
            key = part_key(entry.relative_to(unpacked_dir).as_posix())
            if key in entries:
                raise ValueError(f"duplicate unpacked entry: {entry}")
            entries[key] = entry
            yield entry.stat().st_size if entry.is_file() else 0

    check_entry_budget(entry_sizes())
    return entries


def add_comment(
    unpacked_dir: Path | str,
    text: str,
    comment_id: int | None = None,
    author: str = "Claude",
    initials: str = "C",
    parent_id: int | None = None,
    raw: bool = False,
) -> tuple[int, str, str]:
    unpacked_dir = Path(unpacked_dir)
    if not raw:
        text = xml_escape(text)
    author = xml_escape(author, ATTRIBUTE_ESCAPES)
    initials = xml_escape(initials, ATTRIBUTE_ESCAPES)
    entries = _check_directory(unpacked_dir)

    def resolve(part: str) -> Path:
        key = part_key(quote(part, safe="/"))
        parent_key = key.rpartition("/")[0]
        path = entries.get(key, entries.get(parent_key, unpacked_dir / Path(part).parent)
                           / Path(part).name)
        if not path.resolve().is_relative_to(unpacked_dir.resolve()):
            raise ValueError(f"relationship target escapes the package: {part!r}")
        return path

    def read(part: str) -> bytes:
        return resolve(part).read_bytes()

    rels_path, rels, parts, new_parts, word_ns = _resolve_comment_parts(read, create=True)
    namespaces = {**NS, "w": word_ns}
    data = {}
    for name, part in parts.items():
        if name in new_parts:
            if resolve(part).exists():
                raise ValueError(f"unrelated part already occupies {part}")
            data[name] = (TEMPLATE_DIR / f"{name}.xml").read_bytes().replace(
                WORD_NS.encode(), word_ns.encode(),
            )
        else:
            data[name] = read(part)

    comments = _comments_by_id(data["comments"], word_ns)
    if comment_id is None:
        comment_id = max(comments, default=-1) + 1
    if comment_id in comments:
        raise ValueError(f"comment ID {comment_id} already exists")

    parent_para = ""
    if parent_id is not None:
        if parent_id not in comments:
            raise ValueError(f"parent comment {parent_id} not found")
        parent_para = _last_para_id(comments[parent_id], word_ns)
        if not parent_para:
            raise ValueError(
                f"cannot add reply to comment {parent_id}: its last paragraph must have w14:paraId"
            )

    # Word keys thread and durable ID records by paragraph ID.
    used_para_ids = {
        element.getAttributeNS(NS["w14"], "paraId")
        for element in _parse(data["comments"]).getElementsByTagNameNS(word_ns, "p")
    }
    used_durable_ids = {
        element.getAttributeNS(NS["w16cid"], "durableId")
        for element in _parse(data["commentsIds"]).getElementsByTagNameNS(NS["w16cid"], "commentId")
    }
    para_id = _generate_hex_id()
    while para_id in used_para_ids:
        para_id = _generate_hex_id()
    durable_id = _generate_hex_id()
    while durable_id in used_durable_ids:
        durable_id = _generate_hex_id()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    parent_attribute = (
        f' w15:paraIdParent="{xml_escape(parent_para, ATTRIBUTE_ESCAPES)}"' if parent_para else ""
    )

    additions = {
        "comments": ("w:comments", COMMENT_XML.format(
            id=comment_id, author=author, date=ts, initials=initials, para_id=para_id, text=text,
        )),
        "commentsExtended": ("w15:commentsEx",
            f'<w15:commentEx w15:paraId="{para_id}"{parent_attribute} w15:done="0"/>'),
        "commentsIds": ("w16cid:commentsIds",
            f'<w16cid:commentId w16cid:paraId="{para_id}" w16cid:durableId="{durable_id}"/>'),
        "commentsExtensible": ("w16cex:commentsExtensible",
            f'<w16cex:commentExtensible w16cex:durableId="{durable_id}" w16cex:dateUtc="{ts}"/>'),
    }
    writes = {
        parts[name]: _append_xml(data[name], root, addition, namespaces)
        for name, (root, addition) in additions.items()
    }
    if new_parts:
        writes[rels_path] = rels.toxml(encoding="UTF-8")
    if content_types := _comment_content_types(read("[Content_Types].xml"), parts):
        writes["[Content_Types].xml"] = content_types
    for part, content in writes.items():
        target = resolve(part)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    _verify_saved_comment(read, comment_id, para_id, parent_id)
    action = "reply" if parent_id is not None else "comment"
    return comment_id, para_id, f"Added {action} id={comment_id} (paraId={para_id})"


def main() -> None:
    p = argparse.ArgumentParser(description="Add a comment to a DOCX (directory or .docx file).")
    p.add_argument("input", help="Unpacked DOCX directory OR a .docx/.dotx file")
    p.add_argument("text", help="Comment text (plain text; XML-escaped automatically)")
    p.add_argument("--raw", action="store_true",
                   help="Treat text as pre-escaped XML (skip automatic escaping)")
    p.add_argument("--id", type=int, dest="comment_id",
                   help="Comment ID (default: auto-assign as max existing + 1)")
    p.add_argument("--author", default="Claude", help="Author name")
    p.add_argument("--initials", default="C", help="Author initials")
    p.add_argument("--parent", type=int, help="Reply to this comment ID (last paragraph needs w14:paraId)")
    p.add_argument("-o", "--output",
                   help="Output .docx path (only used when input is a .docx; default: overwrite input)")
    args = p.parse_args()

    src = Path(args.input)

    try:
        if src.is_dir():
            if args.output:
                print("Warning: --output ignored for directory input", file=sys.stderr)
            cid, _, msg = add_comment(
                src, args.text, comment_id=args.comment_id,
                author=args.author, initials=args.initials,
                parent_id=args.parent, raw=args.raw,
            )
            print(msg)
        elif src.is_file() and src.suffix.lower() in (".docx", ".dotx"):
            out = Path(args.output) if args.output else src
            with tempfile.TemporaryDirectory() as tmp:
                tmp_path = Path(tmp)
                with zipfile.ZipFile(src) as zf:
                    check_zip_members(zf)
                    _safe_extract(zf, tmp_path)
                cid, para_id, msg = add_comment(
                    tmp_path, args.text, comment_id=args.comment_id,
                    author=args.author, initials=args.initials,
                    parent_id=args.parent, raw=args.raw,
                )
                with tempfile.TemporaryDirectory(dir=out.parent) as staging:
                    staged = Path(staging) / out.name
                    _rezip(tmp_path, staged)
                    with zipfile.ZipFile(staged) as saved:
                        check_zip_members(saved)
                        parts = {part_key(name): name for name in saved.namelist()}

                        def read(part: str) -> bytes:
                            return saved.read(parts[part_key(quote(part, safe="/"))])

                        _verify_saved_comment(read, cid, para_id, args.parent)
                    if out.exists():
                        staged.chmod(out.stat().st_mode & 0o777)
                    os.replace(staged, out)
            print(msg)
            print(f"Wrote {out} (comment defined; add markers to the target story to make it visible)")
        else:
            print(f"Error: {src} is neither a directory nor a .docx/.dotx file", file=sys.stderr)
            sys.exit(1)
    except (OSError, KeyError, ValueError, RuntimeError, zipfile.BadZipFile,
            ExpatError, DefusedXmlException) as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.parent is not None:
        print(REPLY_MARKER_TEMPLATE.format(pid=args.parent, cid=cid))
    else:
        print(COMMENT_MARKER_TEMPLATE.format(cid=cid))


if __name__ == "__main__":
    main()
