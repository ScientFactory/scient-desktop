#!/usr/bin/env python3
"""Scient document tools (lab build).

One CLI for every document skill:
  doc.py probe                      runtime capability report (JSON)
  doc.py inspect FILE               edit-grade structured inspection (JSON)
  doc.py text FILE                  quick-look text (PDFs include JSON diagnostics)
  doc.py render FILE --out DIR     rendered page PNGs (+ --pdf) for visual QA
  doc.py render-diff A B --out DIR per-page pixel diff between two renders
  doc.py validate FILE [--original F] [--author NAME]   OOXML XSD/rel checks
  doc.py recalc FILE                LibreOffice recalc + formula error JSON
  doc.py convert IN OUT             pandoc/LibreOffice conversion + fidelity note

Use trusted fixtures until the lab runs in OS-level isolation. The conversion
profiles and ZIP budgets provide limited protections.

Run with the document runtime python:
  /Users/yaacov/REPOs/ScientFactory/document-lab/.venv/bin/python tools/doc.py ...
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile
from collections import Counter
from contextlib import closing, contextmanager, redirect_stderr, redirect_stdout, suppress
from dataclasses import dataclass
from datetime import date, time, timedelta
from html.parser import HTMLParser
from itertools import groupby, zip_longest
from pathlib import Path, PureWindowsPath
from urllib.parse import unquote, urlsplit
from uuid import uuid4

TOOLS = Path(__file__).resolve().parent
OOXML_FAMILIES = {
    ".docx": "docx", ".dotx": "docx", ".docm": "docx",
    ".xlsx": "xlsx", ".xlsm": "xlsx", ".xltx": "xlsx",
    ".pptx": "pptx", ".potx": "pptx", ".pptm": "pptx",
}
ZIP_FORMATS = set(OOXML_FAMILIES) | {".odt", ".ods", ".odp", ".epub", ".zip"}
ZIP_MAX_MEMBERS = 10_000
ZIP_MAX_BYTES = 512 * 1024 ** 2
ZIP_MAX_PART_BYTES = 128 * 1024 ** 2
CSV_MAX_BYTES = 64 * 1024 ** 2
PROCESS_TIMEOUT = 300
RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
SPREADSHEET_NAMESPACES = (
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
)
OFFICE_REL_NAMESPACES = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
)
OFFICE_DOCUMENT_TYPES = {f"{ns}/officeDocument" for ns in OFFICE_REL_NAMESPACES}
STRICT_NS = "http://purl.oclc.org/ooxml/"
OFFICE_MAIN_PARTS = {
    "docx": ("word/document.xml", "wordprocessingml", "document"),
    "pptx": ("ppt/presentation.xml", "presentationml", "presentation"),
    "xlsx": ("xl/workbook.xml", "spreadsheetml", "workbook"),
}
OFFICE_MAIN_CONTENT_TYPES = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    ".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    ".docm": "application/vnd.ms-word.document.macroEnabled.main+xml",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    ".potx": "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
    ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    ".xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
}
OFFICE_MAIN_TYPES = {kind.casefold() for kind in OFFICE_MAIN_CONTENT_TYPES.values()} | {
    "application/vnd.ms-word.template.macroenabledtemplate.main+xml",
    "application/vnd.ms-powerpoint.template.macroenabled.main+xml",
    "application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml",
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
    "application/vnd.ms-excel.template.macroenabled.main+xml",
    "application/vnd.ms-excel.sheet.binary.macroenabled.main",
}


class UnsupportedLayout(ValueError):
    def __str__(self):
        return f"unsupported-layout: {super().__str__()}"


class PDFReadError(ValueError):
    def __init__(self, cause, diagnostics):
        super().__init__(f"{type(cause).__name__}: {cause}")
        self.diagnostics = diagnostics


@dataclass
class OfficePackage:
    main_part: str
    members: dict
    content_types: dict
    relationships: dict
    sheets: dict


def run(cmd: list[str], *, timeout=PROCESS_TIMEOUT, **kw) -> subprocess.CompletedProcess:
    binary = shutil.which(cmd[0])
    if binary is None:
        raise FileNotFoundError(f"{cmd[0]} is required on PATH")
    return subprocess.run([str(Path(binary).absolute()), *cmd[1:]],
                          capture_output=True, text=True, timeout=timeout, **kw)


def out_json(obj) -> int:
    print(json.dumps(obj, indent=2, ensure_ascii=False, default=str))
    return 0


# ---------------------------------------------------------------- package security
def _part_key(name: str) -> str:
    return unicodedata.normalize("NFC", unquote(name, errors="strict")).casefold()


def _zip_members(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    infos = archive.infolist()
    if len(infos) > ZIP_MAX_MEMBERS or sum(info.file_size for info in infos) > ZIP_MAX_BYTES:
        raise ValueError("ZIP exceeds the member count or expanded size budget")
    seen, parts = set(), {}
    for info in infos:
        name = info.filename.rstrip("/")
        key = _part_key(name)
        if (not key or "\0" in key or chr(92) in key or PureWindowsPath(key).anchor
                or any(piece in ("", ".", "..") for piece in key.split("/"))
                or info.orig_filename != info.filename
                or stat.S_ISLNK(info.external_attr >> 16)):
            raise ValueError(f"unsafe ZIP member: {info.orig_filename!r}")
        if key in seen:
            raise ValueError(f"duplicate normalized ZIP member: {info.filename!r}")
        if info.file_size > ZIP_MAX_PART_BYTES:
            raise ValueError(f"ZIP member exceeds the expanded size budget: {info.filename!r}")
        seen.add(key)
        if not info.is_dir():
            parts[key] = info
    if any(prefix in parts for key in seen for prefix in _part_parents(key)):
        raise ValueError("ZIP member is both a file and a parent directory")
    return parts


def _part_parents(key: str):
    while "/" in key:
        key = key.rsplit("/", 1)[0]
        yield key


def resolve_package(path: Path, *, recalc=False, expected_suffix=None, check_pdf_pages=True) -> OfficePackage | None:
    """Gate readers on a single conventional Transitional OOXML main part."""
    if not path.is_file():
        raise ValueError(f"{path} is not a file")
    suffix = expected_suffix or path.suffix.lower()
    family = OOXML_FAMILIES.get(suffix)
    if suffix not in ZIP_FORMATS and not zipfile.is_zipfile(path):
        if suffix == ".pdf" and check_pdf_pages:
            _require_pdf_pages(path)
        return None
    with zipfile.ZipFile(path) as archive:
        members = _zip_members(archive)
        if family is None:
            if {"[content_types].xml", "_rels/.rels"} <= members.keys():
                rels = _package_relationships(archive, members["_rels/.rels"])
                if any(_is_office_document(rel) for _, rel in rels):
                    raise UnsupportedLayout(f"Office package has an unsupported extension {suffix!r}")
            if suffix == ".pdf" and check_pdf_pages:
                _require_pdf_pages(path)
            return None
        for name in ("[Content_Types].xml", "_rels/.rels"):
            member = members.get(name.casefold())
            if member is None or member.filename != name:
                raise UnsupportedLayout(f"package requires the conventional part {name}")
        manifest = members["[content_types].xml"]
        content_types, declarations = _package_content_types(archive, manifest, members)
        relationships = dict(_package_relationships(archive, members["_rels/.rels"]))
        candidates = [rel for rel in relationships.values() if _is_office_document(rel)]
        if len(candidates) != 1 or candidates[0]["mode"] != "Internal":
            raise UnsupportedLayout("package requires one internal package-level officeDocument relationship")
        rel = candidates[0]
        if rel["type"].startswith(STRICT_NS):
            raise UnsupportedLayout("strict")
        if rel["type"] not in OFFICE_DOCUMENT_TYPES:
            raise UnsupportedLayout(f"unknown officeDocument relationship type {rel['type']!r}")
        try:
            target = _internal_target(rel["target"], "")
        except ValueError as exc:
            raise UnsupportedLayout(str(exc)) from exc
        if target not in members:
            raise UnsupportedLayout(f"officeDocument relationship has missing target {rel['target']!r}")
        main_part, vocabulary, local_name = OFFICE_MAIN_PARTS[family]
        expected_type = OFFICE_MAIN_CONTENT_TYPES[suffix]
        # Some readers select the first recognized MIME override independently
        # of the officeDocument relationship or require its canonical spelling.
        if declarations != [(f"/{main_part}", expected_type)]:
            raise UnsupportedLayout(
                f"expected type {expected_type!r} for {suffix} with one main-part declaration "
                f"at /{main_part}; found {declarations!r}"
            )
        if members[target].filename != main_part or rel["target"].lstrip("/") != main_part:
            raise UnsupportedLayout(f"expected officeDocument at {main_part}, found {rel['target']!r}")
        root = _read_package_xml(archive, members[target])
        _require_transitional(root)
        expected_root = f"{{http://schemas.openxmlformats.org/{vocabulary}/2006/main}}{local_name}"
        if root.tag != expected_root:
            raise UnsupportedLayout(f"{main_part}: expected {local_name} XML root, found {root.tag!r}")
        sheets = _resolve_workbook_sheets(archive, members, content_types, root, recalc) if family == "xlsx" else {}
        return OfficePackage(main_part, members, content_types, relationships, sheets)


def _is_office_document(rel):
    return rel["type"].endswith("/officeDocument")


def _require_transitional(root):
    marker = "{" + STRICT_NS
    if any(element.tag.startswith(marker) or any(key.startswith(marker) for key in element.attrib)
           for element in root.iter()):
        raise UnsupportedLayout("strict")


def _layout_error(exc):
    return out_json({"code": "unsupported-layout", "error": str(exc)}) or 3


# ---------------------------------------------------------------- probe
def cmd_probe(_args) -> int:
    mods = {}
    for name in ("docx", "openpyxl", "pptx", "pypdf", "pdfplumber",
                 "reportlab", "defusedxml", "lxml", "pandas", "markitdown", "PIL"):
        try:
            m = __import__(name)
            mods[name] = getattr(m, "__version__", "ok")
        except Exception:
            mods[name] = None
    bins = {b: shutil.which(b) for b in ("soffice", "pandoc", "pdftoppm", "pdfinfo", "qpdf", "node")}
    node_libs = {lib: (TOOLS / "node" / "node_modules" / lib).is_dir()
                 for lib in ("docx", "pptxgenjs")}
    validate = (TOOLS / "office" / "validate.py").is_file()
    recalc = (TOOLS / "recalc.py").is_file()
    soffice = bool(bins["soffice"] and mods["defusedxml"]
                   and (TOOLS / "office" / "soffice.py").is_file())
    pdf_page_count = bool(bins["qpdf"] or mods["pypdf"])
    commands = {
        "inspect": {fmt: bool(mods[mod]) for fmt, mod in
                    (("docx", "docx"), ("xlsx", "openpyxl"), ("pptx", "pptx"),
                     ("pdf", "pypdf"), ("csv", "pandas"))},
        "text": {"markitdown": bool(mods["markitdown"]), "docx_fallback": bool(bins["pandoc"]),
                 "pdf": bool(mods["pypdf"])},
        "render": {"pdf": bool(bins["pdftoppm"] and pdf_page_count),
                   "office": bool(bins["pdftoppm"] and pdf_page_count and soffice)},
        "validate": {"pdf": bool(bins["qpdf"]), "xlsx": bool(mods["defusedxml"]),
                     "docx_and_pptx": bool(validate and mods["lxml"] and mods["defusedxml"])},
        "recalc": {"xlsx": bool(recalc and soffice and mods["openpyxl"])},
        "convert": {"pandoc": bool(bins["pandoc"]), "soffice": soffice},
    }
    commands["render-diff"] = {fmt: ready and bool(mods["PIL"])
                               for fmt, ready in commands["render"].items()}
    readiness = {command: all(routes.values()) for command, routes in commands.items()}
    return out_json({
        "python": sys.version.split()[0], "python_modules": mods,
        "binaries": bins, "node_libs": node_libs,
        "adopted_scripts": {
            "validate": validate, "recalc": recalc,
            "ooxml_helpers": sorted(p.name for p in (TOOLS / "ooxml").glob("*.py")),
        },
        "command_ready": readiness, "command_routes": commands,
        "ready": all(readiness.values()),
    })


# ---------------------------------------------------------------- soffice
def _configure_soffice(profile: Path, *, app_macro=False) -> None:
    user = profile / "user"
    user.mkdir(parents=True, exist_ok=True)
    security = "/org.openoffice.Office.Common/Security/Scripting"
    settings = {
        security: {
            "MacroSecurityLevel": "3",
            "DisableMacrosExecution": "false" if app_macro else "true",
            # Charts, OLE and math objects count as "active content"; disabling it
            # silently drops them from PDF export (CT1-CT4). Macros stay disabled.
            "DisableActiveContent": "false",
            "BlockUntrustedRefererLinks": "true",
        },
        "/org.openoffice.Office.Calc/Content/Update": {"Link": "1"},  # never
        "/org.openoffice.Office.Writer/Content/Update": {"Link": "2"},  # never
    }
    items = [
        f'<item oor:path="{path}"><prop oor:name="{name}" oor:op="fuse"><value>{value}</value></prop></item>'
        for path, properties in settings.items() for name, value in properties.items()
    ]
    (user / "registrymodifications.xcu").write_text(
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry">' +
        "".join(items) + "</oor:items>", encoding="utf-8",
    )


def _check_output(path: Path, result: subprocess.CompletedProcess, tool: str) -> None:
    if result.returncode != 0:
        raise RuntimeError(f"{tool} failed ({result.returncode}): {result.stderr.strip()[-800:]}")
    if not path.is_file() or not path.stat().st_size:
        raise RuntimeError(f"{tool} did not produce a non-empty {path.name}: "
                           f"{result.stderr.strip()[-800:]}")


def soffice_convert(src: Path, fmt: str, outdir: Path) -> Path:
    """Convert with a fresh profile and reuse the adopted link filter."""
    from office.soffice import _without_outside_links, get_soffice_env

    with tempfile.TemporaryDirectory(prefix="scient-lo-") as work:
        scratch = Path(work)
        profile = scratch / "profile"
        _configure_soffice(profile)
        filtered = _without_outside_links(str(src), scratch / "input")
        result = run(["soffice", "--headless", "--norestore",
                      f"-env:UserInstallation={profile.as_uri()}",
                      "--convert-to", fmt, "--outdir", str(outdir), filtered],
                     env=get_soffice_env())
    dest = outdir / f"{src.stem}.{fmt}"
    _check_output(dest, result, "soffice")
    return dest


def _clear_images(directory: Path, pattern: str) -> None:
    for path in directory.glob(pattern):
        if path.is_file() or path.is_symlink():
            path.unlink()


def render_pages(src: Path, outdir: Path, emit_pdf: bool, dpi: int, *, resolved=False) -> dict:
    src, outdir = src.resolve(), outdir.resolve()
    if not resolved:
        resolve_package(src)
    outdir.mkdir(parents=True, exist_ok=True)
    emitted = None
    with tempfile.TemporaryDirectory(prefix=".scient-render-", dir=outdir) as work:
        scratch = Path(work)
        pdf = src
        if src.suffix.lower() != ".pdf":
            pdf = soffice_convert(src, "pdf", scratch)
            resolve_package(pdf, expected_suffix=".pdf")
        result = run(["pdftoppm", "-cropbox", "-png", "-r", str(dpi), str(pdf), str(scratch / "page")])
        diagnostics = result.stderr.strip().splitlines()
        incomplete = any(re.search(r"\b(?:error|(?:unresolved|unknown|missing)\s+resource)\b",
                                   line, re.IGNORECASE) for line in diagnostics)
        staged = sorted(scratch.glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1]))
        empty = not staged or any(not page.stat().st_size for page in staged)
        if result.returncode or empty:
            error = (f"pdftoppm failed ({result.returncode})" if result.returncode
                     else "pdftoppm did not produce non-empty page images")
            return {"file": str(src), "pdf": None, "page_count": 0, "pages": [],
                    "diagnostics": diagnostics, "incomplete": True, "error": error}
        if emit_pdf:
            emitted = outdir / pdf.name
            if not emitted.exists() or not emitted.samefile(pdf):
                staged_pdf = scratch / pdf.name
                if pdf != staged_pdf:
                    shutil.copy2(pdf, staged_pdf)
                staged_pdf.replace(emitted)
        _clear_images(outdir, "page-*.png")
        pages = [str(page.replace(outdir / page.name)) for page in staged]
    return {"file": str(src), "pdf": str(emitted) if emitted is not None else None,
            "page_count": len(pages), "pages": pages,
            "diagnostics": diagnostics, "incomplete": incomplete}


def cmd_render(args) -> int:
    report = render_pages(Path(args.file), Path(args.out), args.pdf, args.dpi)
    out_json(report)
    return 2 if report["incomplete"] else 0


def cmd_render_diff(args) -> int:
    a_path, b_path = Path(args.a).resolve(), Path(args.b).resolve()
    resolve_package(a_path)
    resolve_package(b_path)
    outdir = Path(args.out).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".scient-diff-", dir=outdir) as work:
        scratch = Path(work)
        a = render_pages(a_path, scratch / "a", False, args.dpi, resolved=True)
        b = render_pages(b_path, scratch / "b", False, args.dpi, resolved=True)
        if a["incomplete"] or b["incomplete"]:
            return out_json({"incomplete": True, "a": {**a, "pages": []},
                             "b": {**b, "pages": []}}) or 2
        return _compare_renders(a, b, outdir, scratch)


def _compare_renders(a, b, outdir, scratch) -> int:
    from PIL import Image, ImageChops

    diffs, added, removed = [], [], []
    diff_dir = outdir / "diff"
    diff_dir.mkdir(parents=True, exist_ok=True)
    _clear_images(diff_dir, "diff-*.png")
    for i, (pa, pb) in enumerate(zip_longest(a["pages"], b["pages"]), 1):
        entry = {"page": i, "changed": True}
        if pa is None:
            added.append(i)
            entry["status"] = "added"
        elif pb is None:
            removed.append(i)
            entry["status"] = "removed"
        else:
            with Image.open(pa) as a_image, Image.open(pb) as b_image:
                if a_image.size != b_image.size:
                    entry["note"] = f"size {a_image.size} vs {b_image.size}"
                else:
                    diff = ImageChops.difference(a_image.convert("RGB"), b_image.convert("RGB"))
                    entry["changed"] = diff.getbbox() is not None
                    if entry["changed"]:
                        path = diff_dir / f"diff-{i}.png"
                        staged = scratch / path.name
                        diff.save(staged)
                        staged.replace(path)
                        entry["diff_image"] = str(path)
        diffs.append(entry)
    return out_json({"a_pages": a["page_count"], "b_pages": b["page_count"],
                     "changed_pages": sum(d["changed"] for d in diffs),
                     "added_pages": added, "removed_pages": removed, "pages": diffs,
                     "page_count_differs": a["page_count"] != b["page_count"]})


# ---------------------------------------------------------------- inspect
def _trunc(s: str, n: int = 160) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"


def _select_word_alternates(root) -> bool:
    """Expand the branch the renderer shows, using namespace URIs, including nested branches.

    Word 2010+ and LibreOffice render mc:Choice branches that require these Office extension
    namespaces, so inspect/text must read the same branch (signoff: w14 choice rendered while
    inspect read the fallback). Unknown requirements still fall back.
    """
    from docx.oxml.ns import nsmap

    supported = {nsmap[prefix] for prefix in ("w", "r", "m", "a", "wp", "pic", "c")} | {
        "http://schemas.microsoft.com/office/word/2010/wordml",                  # w14
        "http://schemas.microsoft.com/office/word/2012/wordml",                  # w15
        "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",     # wps
        "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",     # wpg
        "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas",    # wpc
        "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",   # wp14
        "http://schemas.microsoft.com/office/drawing/2010/main",                 # a14
    }

    def expand(parent):
        for child in list(parent):
            if child.tag != MC + "AlternateContent":
                expand(child)
                continue
            branch = child.find(MC + "Fallback")
            for choice in child.iterchildren(MC + "Choice"):
                requires = choice.get("Requires", "").split()
                if requires and all(choice.nsmap.get(prefix) in supported for prefix in requires):
                    branch = choice
                    break
            if branch is not None:
                expand(branch)
                for item in list(branch):
                    child.addprevious(item)
            parent.remove(child)

    if next(root.iter(MC + "AlternateContent"), None) is None:
        return False
    expand(root)
    return True


@contextmanager
def _word_reader_input(path: Path, package: OfficePackage):
    """Give inspect and text the same expanded main body, in a private copy if needed."""
    from lxml import etree

    with zipfile.ZipFile(path) as source:
        parser = etree.XMLParser(resolve_entities=False, no_network=True)
        root = etree.fromstring(source.read(package.main_part), parser)
        changed = _select_word_alternates(root)
        if not changed and path.suffix.lower() == ".docx":
            yield path
            return
        with tempfile.TemporaryDirectory(prefix="scient-word-read-") as work:
            staged = Path(work) / path.with_suffix(".docx").name
            with zipfile.ZipFile(staged, "w", compression=zipfile.ZIP_DEFLATED) as output:
                for name in source.namelist():
                    if name == package.main_part and changed:
                        output.writestr(name, etree.tostring(root, encoding="utf-8"))
                    elif name == "[Content_Types].xml" and path.suffix.lower() != ".docx":
                        # The Python Word and text readers recognize the regular document subtype.
                        manifest = etree.fromstring(source.read(name), parser)
                        override = manifest.find(f"{{{CONTENT_TYPES_NS}}}Override[@PartName='/{package.main_part}']")
                        override.set("ContentType", OFFICE_MAIN_CONTENT_TYPES[".docx"])
                        output.writestr(name, etree.tostring(manifest, encoding="utf-8"))
                    else:
                        with source.open(name) as original, output.open(name, "w") as target:
                            shutil.copyfileobj(original, target)
            resolve_package(staged)
            yield staged


def inspect_docx(path: Path, package: OfficePackage) -> dict:
    from docx import Document
    from docx.oxml.ns import qn
    from defusedxml.ElementTree import fromstring

    with _word_reader_input(path, package) as staged:
        d = Document(str(staged))
    outline, paras = [], 0
    outline_tag, val_attr = (qn(f"w:{n}") for n in ("outlineLvl", "val"))

    def _outline_level(paragraph):
        """Explicit w:outlineLvl on the paragraph, else inherited through its style chain."""
        ppr = paragraph._p.pPr
        lvl = ppr.find(outline_tag) if ppr is not None else None
        style = paragraph.style
        visited = set()
        while lvl is None and style is not None and style.style_id not in visited:
            visited.add(style.style_id)
            sppr = style.element.pPr
            lvl = sppr.find(outline_tag) if sppr is not None else None
            style = style.base_style
        return int(lvl.get(val_attr)) if lvl is not None else None

    from docx.text.paragraph import Paragraph

    txbx_tag, tbl_tag = qn("w:txbxContent"), qn("w:tbl")
    # Document order over every rendered paragraph, including text-box content
    # (w:txbxContent of the selected AlternateContent branch); python-docx's
    # d.paragraphs skips text boxes, which LibreOffice/Word render.
    for p_el in d.element.body.iter(qn("w:p")):
        ancestors = list(p_el.iterancestors())
        in_box = any(a.tag == txbx_tag for a in ancestors)
        if not in_box and any(a.tag == tbl_tag for a in ancestors):
            continue  # table cells are summarized under "tables"
        p = Paragraph(p_el, d)
        if p.text.strip():
            paras += 1
            level = _outline_level(p)
            name = p.style.name or ""
            is_heading = name.startswith(("Heading", "Title")) if level is None else 0 <= level < 9
            if is_heading:
                entry = {"style": name, "outline_level": level, "text": _trunc(p.text)}
                if in_box:
                    entry["in_text_box"] = True
                outline.append(entry)
    tables = []
    for t in d.tables[:20]:
        rows = [[_trunc(c.text, 60) for c in r.cells] for r in t.rows[:3]]
        tables.append({"rows": len(t.rows), "cols": len(t.columns), "head": rows})
    info: dict = {"format": "docx", "paragraphs_with_text": paras,
                  "outline": outline[:60], "tables": tables,
                  "sections": len(d.sections),
                  "core_title": d.core_properties.title or None}
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        info["images"] = [n for n in names if n.startswith("word/media/")]
        root = d.element
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        info["tracked_insertions"] = len(root.findall(".//w:ins", ns))
        info["tracked_deletions"] = len(root.findall(".//w:del", ns))
        info["footnotes"] = "word/footnotes.xml" in names
        info["endnotes"] = "word/endnotes.xml" in names
        info["comments"] = []
        if "word/comments.xml" in names:
            croot = fromstring(z.read("word/comments.xml"), forbid_dtd=True)
            for c in croot.findall(".//w:comment", ns):
                txt = "".join(t.text or "" for t in c.findall(".//w:t", ns))
                info["comments"].append({
                    "id": c.get(f"{{{ns['w']}}}id"),
                    "author": c.get(f"{{{ns['w']}}}author"),
                    "text": _trunc(txt, 240)})
    return info


@contextmanager
def _sheet_parser(ws):
    """Use openpyxl's read-only parser without padding rows or columns."""
    from openpyxl.worksheet._reader import VALUE_TAG, WorkSheetParser

    class SparseParser(WorkSheetParser):
        def parse_cell(self, element):
            cell = super().parse_cell(element)
            if self.data_only and cell["value"] is None and cell["data_type"] == "str":
                if element.find(VALUE_TAG) is not None:
                    cell.update(value="", data_type="s")
            return cell

    book = ws.parent
    with ws._get_source() as src:
        yield SparseParser(src, ws._shared_strings, data_only=book.data_only,
                           epoch=book.epoch, date_formats=book._date_formats,
                           timedelta_formats=book._timedelta_formats)


def _stored_cells(ws, parser):
    from openpyxl.cell.read_only import ReadOnlyCell

    for _, cells in parser.parse():
        for cell in cells:
            yield ReadOnlyCell(ws, **cell)


def _formula_fields(value) -> dict:
    from openpyxl.worksheet.formula import ArrayFormula, DataTableFormula

    if isinstance(value, ArrayFormula):
        return {"formula": value.text, "type": "array", "ref": value.ref}
    if isinstance(value, DataTableFormula):
        return {"formula": None, "type": "dataTable", **{k: v for k, v in dict(value).items() if k != "t"}}
    return {"formula": value}


def _worksheet_charts(ws) -> int:
    from openpyxl.packaging.relationship import get_dependents, get_rels_path

    archive = ws.parent._archive

    def relationships(part, kind):
        rels = get_rels_path(part)
        if rels in archive.NameToInfo:
            return [r.target for r in get_dependents(archive, rels)
                    if r.TargetMode != "External" and r.Type.endswith(f"/{kind}")]
        return []

    return sum(len(relationships(drawing, "chart"))
               for drawing in relationships(ws._worksheet_path, "drawing"))


def _inspect_xlsx_sheet(ws, cached_sheet) -> dict:
    from openpyxl.utils import get_column_letter

    formulas, errors, formula_errors, sample = [], [], [], []
    formula_count = missing_caches = error_count = formula_error_count = 0
    min_row = max_row = min_col = max_col = None
    with _sheet_parser(ws) as formula_parser, _sheet_parser(cached_sheet) as value_parser:
        for cell, cached in zip(_stored_cells(ws, formula_parser),
                                _stored_cells(cached_sheet, value_parser), strict=True):
            if (cell.row, cell.column) != (cached.row, cached.column):
                raise ValueError(f"worksheet {ws.title} cache and formula coordinates disagree")
            min_row = min(min_row or cell.row, cell.row)
            max_row = max(max_row or cell.row, cell.row)
            min_col = min(min_col or cell.column, cell.column)
            max_col = max(max_col or cell.column, cell.column)
            is_formula = cell.data_type == "f"
            if is_formula:
                formula_count += 1
                missing_caches += cached.value is None
                if len(formulas) < 40:
                    formulas.append({"cell": cell.coordinate, **_formula_fields(cell.value),
                                     "cached": cached.value})
            if cached.data_type == "e":
                error_count += 1
                error = {"cell": cached.coordinate, "error": cached.value}
                if len(errors) < 40:
                    errors.append(error)
                if is_formula:
                    formula_error_count += 1
                    if len(formula_errors) < 40:
                        formula_errors.append(error)
            if len(sample) < 12 and cell.row <= 6 and cell.value is not None:
                sample.append({"cell": cell.coordinate, "value": cached.value})

        merged = formula_parser.merged_cells.mergeCell if formula_parser.merged_cells else []
        for region in merged:
            left, top, right, bottom = region.bounds
            min_row = min(min_row or top, top)
            max_row = max(max_row or bottom, bottom)
            min_col = min(min_col or left, left)
            max_col = max(max_col or right, right)

    max_row, max_col = max_row or 1, max_col or 1
    dims = f"{get_column_letter(min_col or 1)}{min_row or 1}:{get_column_letter(max_col)}{max_row}"
    return {"name": ws.title, "kind": "worksheet", "dims": dims,
            "max_row": max_row, "max_col": max_col,
            "merged": [str(m) for m in merged[:10]],
            "charts": _worksheet_charts(ws), "formula_count": formula_count,
            "formulas_sample": formulas, "missing_caches": missing_caches,
            "error_count": error_count, "errors_sample": errors,
            "formula_error_count": formula_error_count,
            "formula_errors": formula_errors, "sample": sample}

def _xlsx_drawing_inventory(z: zipfile.ZipFile, names: list[str]) -> dict:
    """Count existing chart frames and other drawing content (openpyxl re-saves rewrite or drop them)."""
    from defusedxml.ElementTree import fromstring
    xdr = "{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}"
    chart_uri = "http://schemas.openxmlformats.org/drawingml/2006/chart"
    charts = shapes = groups = 0
    for name in names:
        if not (name.startswith("xl/drawings/") and name.endswith(".xml") and "/_rels/" not in name):
            continue
        root = fromstring(z.read(name))
        for frame in root.iter(f"{xdr}graphicFrame"):
            uris = [el.get("uri") for el in frame.iter() if el.tag.endswith("graphicData")]
            if chart_uri in uris:
                charts += 1
            else:
                shapes += 1  # SmartArt/other graphic frames
        groups += sum(1 for _ in root.iter(f"{xdr}grpSp"))
        for tag in ("sp", "pic", "cxnSp"):
            shapes += sum(1 for _ in root.iter(f"{xdr}{tag}"))
    # openpyxl does not round-trip charts it *reads*: an open+save of an existing workbook drops
    # them (T8: EIA workbook no-op save removed 247 parts). Charts created in the same openpyxl
    # session are written normally. So any existing chart or shape is at risk on an openpyxl save.
    return {"drawing_charts": charts, "drawing_shapes": shapes, "drawing_groups": groups,
            "drawings_shapes": shapes + groups > 0,
            "openpyxl_save_drops_drawings": charts + shapes + groups > 0}



def _check_sheet_inventory(book, package):
    from openpyxl.chartsheet import Chartsheet

    expected = [(title, kind) for title, (kind, _) in package.sheets.items()]
    read = [(sheet.title, "chartsheet" if isinstance(sheet, Chartsheet) else "worksheet")
            for sheet in (book[title] for title in book.sheetnames)]
    if expected != read:
        raise UnsupportedLayout(f"workbook sheet inventory disagrees with its declarations: {read!r}")
    for sheet in book.worksheets:
        if sheet._worksheet_path != package.sheets[sheet.title][1]:
            raise UnsupportedLayout(f"worksheet path disagrees with its declaration: {sheet.title!r}")


def inspect_xlsx(path: Path, package: OfficePackage) -> dict:
    from openpyxl import load_workbook
    from openpyxl.chartsheet import Chartsheet

    _spreadsheet_package(path, package, verify_parts=False)
    with closing(load_workbook(path, read_only=True, keep_links=False)) as formulas, closing(
            load_workbook(path, read_only=True, data_only=True, keep_links=False)) as values:
        _check_sheet_inventory(formulas, package)
        _check_sheet_inventory(values, package)
        sheets = []
        for name in formulas.sheetnames:
            ws = formulas[name]
            if isinstance(ws, Chartsheet):
                sheets.append({"name": name, "kind": "chartsheet", "charts": len(ws._charts)})
            else:
                sheets.append(_inspect_xlsx_sheet(ws, values[name]))
        info = {"format": "xlsx", "sheets": sheets,
                "defined_names": list(formulas.defined_names)[:40],
                "error_count": sum(s.get("error_count", 0) for s in sheets),
                "missing_caches": sum(s.get("missing_caches", 0) for s in sheets)}
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        info["preserve_warnings"] = {
            **_xlsx_drawing_inventory(z, names),
            "slicers": any(n.startswith("xl/slicers/") for n in names),
            "macros_vba": any("vbaProject" in n for n in names),
            "pivot_tables": any(n.startswith("xl/pivotTables/") for n in names),
            "note": "openpyxl save drops shapes/slicers/text boxes; if true, prefer XML edit or wrapped engine.",
        }
    return info


def inspect_pptx(path: Path) -> dict:
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    from pptx.package import Package

    def walk_shapes(shapes):
        for shape in shapes:
            yield shape
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                yield from walk_shapes(shape.shapes)

    prs = Package.open(str(path)).main_document_part.presentation
    slides = []
    for i, s in enumerate(prs.slides, 1):
        texts, tables, charts, pics = [], 0, 0, 0
        for sh in walk_shapes(s.shapes):
            if sh.has_text_frame and sh.text_frame.text.strip():
                texts.append(_trunc(sh.text_frame.text))
            if sh.has_table:
                tables += 1
            if sh.has_chart:
                charts += 1
            if sh.shape_type in (MSO_SHAPE_TYPE.PICTURE, MSO_SHAPE_TYPE.LINKED_PICTURE):
                pics += 1
        notes = ""
        if s.has_notes_slide:
            notes = _trunc(s.notes_slide.notes_text_frame.text, 240)
        slides.append({"slide": i, "layout": s.slide_layout.name,
                       "title": _trunc(s.shapes.title.text) if s.shapes.title else None,
                       "text_blocks": texts[:8], "tables": tables,
                       "charts": charts, "pictures": pics, "notes": notes or None})
    return {"format": "pptx", "slide_count": len(slides),
            "size_inches": [round(prs.slide_width / 914400, 2),
                            round(prs.slide_height / 914400, 2)],
            "slides": slides}


@contextmanager
def _pdf_diagnostics():
    diagnostics = []

    class CollectWarnings(logging.Handler):
        def emit(self, record):
            diagnostics.append(record.getMessage())

    logger = logging.getLogger("pypdf")
    handler = CollectWarnings(logging.WARNING)
    propagate = logger.propagate
    logger.propagate = False
    logger.addHandler(handler)
    try:
        yield diagnostics
    except Exception as exc:
        raise PDFReadError(exc, diagnostics) from exc
    finally:
        logger.removeHandler(handler)
        logger.propagate = propagate


def _pdf_pages(stream):
    from pypdf import PdfReader

    reader = PdfReader(stream)
    if not len(reader.pages):
        raise ValueError("PDF has zero pages")
    return reader


def _require_pdf_pages(path):
    # Use a lightweight count for rendering and validation, including large Calc exports.
    if shutil.which("qpdf"):
        result = run(["qpdf", "--show-npages", str(path)])
        count = result.stdout.strip()
        if result.returncode in (0, 3) and count.isdecimal():
            if int(count) == 0:
                raise ValueError("PDF has zero pages")
            return
    with path.open("rb") as stream:
        _pdf_pages(stream)


def _read_pdf(path: Path, *, inspect=False):
    with _pdf_diagnostics() as diagnostics, path.open("rb") as stream:
        reader = _pdf_pages(stream)
        texts, failed_pages = [], []
        for i, page in enumerate(reader.pages, 1):
            try:
                texts.append(page.extract_text() or "")
            except Exception as exc:
                failed_pages.append(i)
                diagnostics.append(f"page {i}: {type(exc).__name__}: {exc}")
                texts.append("")

        textful = sum(bool(text.strip()) for text in texts)
        report = {"format": "pdf", "pages": len(reader.pages), "encrypted": reader.is_encrypted,
                  "pages_with_text_layer": textful, "failed_pages": failed_pages,
                  "likely_scanned": "unknown" if diagnostics else textful == 0,
                  "diagnostics": diagnostics}
        if inspect:
            try:
                fields = {k: str(v.get("/V", ""))[:80] for k, v in (reader.get_fields() or {}).items()}
            except Exception as exc:
                fields = {"_error": "get_fields failed"}
                diagnostics.append(f"get_fields: {exc}")
            report.update(metadata={k: str(v) for k, v in dict(reader.metadata or {}).items()},
                          acroform_fields=fields)
        return report, texts


def inspect_pdf(path: Path) -> dict:
    report, _ = _read_pdf(path, inspect=True)
    return report


def inspect_csv(path: Path) -> dict:
    import pandas as pd
    sep = "\t" if path.suffix.lower() == ".tsv" else ","
    df = pd.read_csv(path, sep=sep, nrows=8)
    total = sum(1 for _ in open(path, encoding="utf-8", errors="ignore")) - 1
    return {"format": path.suffix.lstrip("."), "rows_approx": total,
            "columns": list(df.columns), "dtypes": {c: str(t) for c, t in df.dtypes.items()},
            "head": df.head(5).fillna("").astype(str).to_dict("records")}


def cmd_inspect(args) -> int:
    path = Path(args.file).resolve()
    ext = path.suffix.lower()
    package = resolve_package(path, check_pdf_pages=False)
    family = OOXML_FAMILIES.get(ext, ext)
    if family == "docx":
        return out_json(inspect_docx(path, package))
    if family == "xlsx":
        return out_json(inspect_xlsx(path, package))
    inspectors = {"pptx": inspect_pptx,
                  ".pdf": inspect_pdf, ".csv": inspect_csv, ".tsv": inspect_csv}
    inspect = inspectors.get(family)
    if inspect is None:
        raise ValueError(f"no inspector for {ext}; use text or convert first")
    return out_json(inspect(path))


# ---------------------------------------------------------------- validate
def _read_package_xml(archive, member):
    from defusedxml.ElementTree import fromstring

    try:
        return fromstring(archive.read(member), forbid_dtd=True)
    except Exception as exc:
        name = member.filename if isinstance(member, zipfile.ZipInfo) else member
        raise ValueError(f"{name}: {exc}") from exc


def _relationship_owner(name: str) -> str:
    if name == "_rels/.rels":
        return ""
    folder, rel_name = posixpath.split(name)
    base, rel_dir = posixpath.split(folder)
    if rel_dir != "_rels" or rel_name == ".rels":
        raise ValueError(f"invalid relationship part path: {name!r}")
    return posixpath.join(base, rel_name.removesuffix(".rels"))


def _internal_target(target: str, owner: str) -> str:
    uri = urlsplit(target)
    if uri.scheme or uri.netloc or uri.query:
        raise ValueError(f"invalid internal relationship target {target!r}")
    path = _part_key(uri.path)
    if not path:
        return owner
    if chr(92) in path or path.startswith("//"):
        raise ValueError(f"invalid internal relationship target {target!r}")
    # Normalize from the package root while detecting attempts to walk past it.
    if not path.startswith("/"):
        path = posixpath.join(posixpath.dirname(owner), path)
    pieces = []
    for piece in path.split("/"):
        if piece == "..":
            if not pieces:
                raise ValueError(f"relationship target escapes the package: {target!r}")
            pieces.pop()
        elif piece not in ("", "."):
            pieces.append(piece)
    return "/".join(pieces)


def _package_content_types(archive, member, members):
    manifest = _read_package_xml(archive, member)
    if manifest.tag != f"{{{CONTENT_TYPES_NS}}}Types":
        raise UnsupportedLayout("invalid [Content_Types].xml root")
    defaults, overrides, main_declarations = {}, {}, []
    for element in manifest:
        raw_type = element.get("ContentType", "")
        content_type = raw_type.casefold()
        if element.tag == f"{{{CONTENT_TYPES_NS}}}Default":
            declarations, name = defaults, element.get("Extension", "")
            key = name.casefold()
        elif element.tag == f"{{{CONTENT_TYPES_NS}}}Override":
            declarations, name = overrides, element.get("PartName", "")
            key = _part_key(name.lstrip("/"))
        else:
            raise UnsupportedLayout(f"unexpected content type declaration {element.tag!r}")
        if not key or not content_type or key in declarations:
            raise UnsupportedLayout(f"invalid or duplicate content type declaration for {name!r}")
        declarations[key] = content_type
        if content_type in OFFICE_MAIN_TYPES:
            main_declarations.append((name, raw_type))
    types = {name: overrides.get(name, defaults.get(name.rsplit(".", 1)[-1])) for name in members}
    return types, main_declarations


def _package_relationships(archive, member):
    root = _read_package_xml(archive, member)
    error = UnsupportedLayout if member.filename == "_rels/.rels" else ValueError
    if root.tag != f"{{{RELS_NS}}}Relationships":
        raise error(f"invalid relationships root: {member.filename}")
    seen = set()
    for rel in root:
        rel_id, kind, target = (rel.get(k) for k in ("Id", "Type", "Target"))
        mode = rel.get("TargetMode", "Internal")
        if (rel.tag != f"{{{RELS_NS}}}Relationship" or rel_id in seen
                or not (rel_id and kind and target) or mode not in ("Internal", "External")):
            raise error(f"{member.filename}: invalid or duplicate relationship {rel_id!r}")
        seen.add(rel_id)
        yield rel_id, {"type": kind, "target": target, "mode": mode}


SHEET_CONTENT_TYPES = {
    "worksheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
    "chartsheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml",
    "dialogsheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.dialogsheet+xml",
    "xlMacrosheet": "application/vnd.ms-excel.macrosheet+xml",
    "xlIntlMacrosheet": "application/vnd.ms-excel.intlmacrosheet+xml",
}
SHARED_STRINGS_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedstrings+xml"
STYLES_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"
SPREADSHEET_XML_ROOTS = {
    SHEET_CONTENT_TYPES["worksheet"]: "worksheet",
    SHEET_CONTENT_TYPES["chartsheet"]: "chartsheet",
    SHEET_CONTENT_TYPES["dialogsheet"]: "dialogsheet",
    SHEET_CONTENT_TYPES["xlMacrosheet"]: "macrosheet",
    SHEET_CONTENT_TYPES["xlIntlMacrosheet"]: "macrosheet",
    SHARED_STRINGS_TYPE: "sst",
    STYLES_TYPE: "styleSheet",
}


def _resolve_workbook_sheets(archive, members, content_types, root, recalc):
    from defusedxml.ElementTree import iterparse

    workbook = "xl/workbook.xml"
    rel_path = "xl/_rels/workbook.xml.rels"
    rel_part = members.get(rel_path)
    if rel_part is None or rel_part.filename != rel_path:
        raise UnsupportedLayout(f"workbook requires {rel_path}")
    relationships = dict(_package_relationships(archive, rel_part))
    if any(rel["type"].startswith(STRICT_NS) for rel in relationships.values()):
        raise UnsupportedLayout("strict")

    ns = f"{{{SPREADSHEET_NAMESPACES[0]}}}"
    containers = root.findall(ns + "sheets")
    if len(containers) > 1:
        raise UnsupportedLayout("workbook has competing sheet declarations")
    declared = root.findall(f"{ns}sheets/{ns}sheet")
    if recalc and sum(element.tag.endswith("}sheet") for element in root.iter()) != len(declared):
        raise UnsupportedLayout("workbook has competing sheet declarations")
    sheets = {}
    names, targets = set(), set()
    relationship_prefix = OFFICE_REL_NAMESPACES[0] + "/"
    for element in declared:
        title, rel_id = element.get("name"), element.get(f"{{{OFFICE_REL_NAMESPACES[0]}}}id")
        if not rel_id:
            raise ValueError(f"sheet {title!r} requires one r:id")
        rel = relationships.get(rel_id)
        if rel is None or rel["mode"] != "Internal":
            raise ValueError(f"sheet {title!r} r:id {rel_id!r} has no internal workbook relationship")
        target = _internal_target(rel["target"], workbook)
        if target not in members:
            raise ValueError(f"{rel_path} {rel_id}: missing target {rel['target']!r}")
        kind = rel["type"].removeprefix(relationship_prefix)
        if rel["type"] not in (relationship_prefix + "worksheet", relationship_prefix + "chartsheet"):
            raise UnsupportedLayout(f"sheet {title!r} has unsupported relationship type {rel['type']!r}")
        part = members[target]
        if content_types[target] != SHEET_CONTENT_TYPES[kind]:
            raise ValueError(f"sheet {title!r} does not resolve to a part of the expected type: {part.filename}")
        raw_target = rel["target"]
        reader_target = (raw_target[1:] if raw_target.startswith("/")
                         else posixpath.normpath(posixpath.join("xl", raw_target)))
        if reader_target != part.filename:
            raise UnsupportedLayout(f"sheet {title!r} uses an ambiguous relationship target {raw_target!r}")
        if not title or title in names or target in targets:
            raise UnsupportedLayout(f"missing or competing workbook sheet declaration for {title!r}")
        names.add(title)
        targets.add(target)
        sheets[title] = (kind, part.filename)
    if not sheets:
        raise ValueError("workbook requires at least one declared sheet")

    if recalc:
        _require_recalc_namespace(archive, members[workbook])
    for target in members:
        expected_root = SPREADSHEET_XML_ROOTS.get(content_types[target])
        if expected_root is None:
            continue
        part = members[target]
        try:
            with archive.open(part) as stream:
                _, part_root = next(iterparse(stream, ("start",), forbid_dtd=True))
        except Exception as exc:
            raise ValueError(f"{part.filename}: {exc}") from exc
        _require_transitional(part_root)
        if target in targets and part_root.tag != ns + expected_root:
            raise ValueError(f"{part.filename}: expected {expected_root} XML root, found {part_root.tag!r}")
        if recalc and (target in targets or expected_root in ("sst", "styleSheet")):
            _require_recalc_namespace(archive, part)
    return sheets


def _require_recalc_namespace(archive, part):
    from xml.parsers import expat

    parser = expat.ParserCreate(namespace_separator="}")
    parser.namespace_prefixes = True
    sheet_namespace = SPREADSHEET_NAMESPACES[0] + "}"

    def check_element(name, attrs):
        if name.startswith(STRICT_NS) or any(key.startswith(STRICT_NS) for key in attrs):
            raise UnsupportedLayout("strict")
        if name.startswith(sheet_namespace) and name.count("}") > 1:
            raise UnsupportedLayout("prefixed namespaces; normalize first")

    def reject_dtd(*_args):
        raise ValueError(f"{part.filename}: DTD is unsupported")

    parser.StartElementHandler = check_element
    parser.StartDoctypeDeclHandler = reject_dtd
    with archive.open(part) as stream:
        while block := stream.read(64 * 1024):
            parser.Parse(block, False)
        parser.Parse(b"", True)


def _spreadsheet_xml(archive, member, expected_root, *, check_cell=None):
    """Check well-formed XML without keeping a worksheet or shared string table in memory."""
    from defusedxml.ElementTree import iterparse

    stack, item_count = [], 0
    expected_tags = {f"{{{SPREADSHEET_NAMESPACES[0]}}}{expected_root}"}
    if expected_root == "macrosheet":
        expected_tags.add("{http://schemas.microsoft.com/office/excel/2006/main}macrosheet")
    try:
        with archive.open(member) as stream:
            for event, element in iterparse(stream, ("start", "end"), forbid_dtd=True):
                if event == "start":
                    if element.tag.startswith("{" + STRICT_NS) or any(
                        key.startswith("{" + STRICT_NS) for key in element.attrib
                    ):
                        raise UnsupportedLayout("strict")
                    if not stack:
                        if element.tag not in expected_tags:
                            raise ValueError(f"expected {expected_root} XML root, found {element.tag!r}")
                        namespace = element.tag.rsplit("}", 1)[0] + "}"
                    stack.append(element)
                    if expected_root == "sst" and len(stack) == 2 and element.tag == namespace + "si":
                        item_count += 1
                    elif (expected_root == "styleSheet" and len(stack) == 3
                          and stack[-2].tag == namespace + "cellXfs" and element.tag == namespace + "xf"):
                        item_count += 1
                else:
                    stack.pop()
                    if check_cell is not None:
                        if (len(stack) == 4 and stack[-1].tag == namespace + "c"
                                and stack[1].tag == namespace + "sheetData"
                                and stack[2].tag == namespace + "row"):
                            # Keep a cell's direct children until its closing tag.
                            continue
                        if (len(stack) == 3 and stack[1].tag == namespace + "sheetData"
                                and stack[2].tag == namespace + "row" and element.tag == namespace + "c"):
                            check_cell(element, namespace)
                    if stack:
                        stack[-1].remove(element)
                    element.clear()
    except UnsupportedLayout:
        raise
    except Exception as exc:
        raise ValueError(f"{member.filename}: {exc}") from exc
    return item_count


def _check_cell_index(index, size, label, title, cell):
    try:
        if 0 <= int(index) < size:
            return
    except (TypeError, ValueError):
        pass
    address = f"{title}!{cell.get('r', '(no cell address)')}"
    raise ValueError(f"{address}: {label} index {index!r} has no matching entry ({size} available)")


def _check_spreadsheet_cell(cell, ns, shared_strings, cell_styles, title, missing_caches):
    kind = cell.get("t", "n")
    if kind == "s":
        _check_cell_index(cell.findtext(ns + "v"), shared_strings, "sharedStrings", title, cell)
    if "s" in cell.attrib:
        _check_cell_index(cell.get("s"), cell_styles, "cell style", title, cell)
    if missing_caches is not None and cell.find(ns + "f") is not None:
        # openpyxl emits an empty <v/> for uncomputed numeric formulas.
        # A string cache may legitimately represent the empty string.
        if kind != "str" and not cell.findtext(ns + "v", "").strip():
            missing_caches["count"] += 1
            if len(missing_caches["locations"]) < 100:
                missing_caches["locations"].append(f"{title}!{cell.get('r', '(no cell address)')}")


def _spreadsheet_package(path: Path, package: OfficePackage, *,
                         fingerprint=False, verify_parts=True, missing_caches=None):
    with zipfile.ZipFile(path) as archive:
        members = package.members
        parts = {}
        if verify_parts or fingerprint:
            for member in members.values():
                digest = hashlib.sha256() if fingerprint else None
                with archive.open(member) as stream:
                    while block := stream.read(1024 ** 2):
                        if digest is not None:
                            digest.update(block)
                parts[member.filename] = digest.hexdigest() if digest is not None else None

        content_types = package.content_types
        workbook = package.main_part
        relationships, internal = {}, {}
        for name, member in members.items():
            if not name.endswith(".rels"):
                continue
            owner = _relationship_owner(name)
            if owner and owner not in members:
                raise ValueError(f"{member.filename} has no source part {owner}")
            rels = package.relationships.items() if not owner else _package_relationships(archive, member)
            for rel_id, rel in rels:
                if rel["type"].startswith(STRICT_NS):
                    raise UnsupportedLayout("strict")
                relationships[member.filename, rel_id] = rel
                if rel["mode"] == "Internal":
                    target = rel["target"]
                    resolved = _internal_target(target, owner)
                    if resolved not in members:
                        raise ValueError(f"{member.filename} {rel_id}: missing target {target!r}")
                    internal[(owner, rel_id)] = rel["type"], resolved
        worksheet_titles = {_part_key(part): title for title, (kind, part) in package.sheets.items()
                            if kind == "worksheet"}

        workbook_dependencies = {f"{OFFICE_REL_NAMESPACES[0]}/{kind}": content_type
                                 for kind, content_type in (("styles", STYLES_TYPE),
                                                            ("sharedStrings", SHARED_STRINGS_TYPE))}
        dependency_counts, dependencies = {}, set()
        for (owner, _), (kind, target) in internal.items():
            if owner != workbook or kind not in workbook_dependencies:
                continue
            expected_type = workbook_dependencies[kind]
            if content_types[target] != expected_type or expected_type in dependency_counts:
                raise ValueError(f"unexpected or duplicate spreadsheet part type: {members[target].filename}")
            count = _spreadsheet_xml(archive, members[target], SPREADSHEET_XML_ROOTS[expected_type])
            dependency_counts[expected_type] = count
            dependencies.add(target)
        for name, member in members.items():
            if name == workbook or name in dependencies:
                continue
            expected_root = SPREADSHEET_XML_ROOTS.get(content_types[name])
            if expected_root is None and name.endswith(".xml"):
                # Also parse conventional parts that are orphaned or lack a specific override.
                if name.startswith("xl/worksheets/"):
                    expected_root = "worksheet"
                else:
                    expected_root = {"xl/workbook.xml": "workbook", "xl/sharedstrings.xml": "sst",
                                     "xl/styles.xml": "styleSheet"}.get(name)
            if expected_root is not None:
                check_cell = None
                if name in worksheet_titles:
                    # Parse synchronously, so each call sees this worksheet's title.
                    def check_cell(cell, ns):
                        _check_spreadsheet_cell(cell, ns, dependency_counts.get(SHARED_STRINGS_TYPE, 0),
                                                dependency_counts.get(STYLES_TYPE, 1),
                                                worksheet_titles[name], missing_caches)

                _spreadsheet_xml(archive, member, expected_root, check_cell=check_cell)
        return parts, relationships


def _changes(before: dict, after: dict) -> dict:
    return {"added": sorted(after.keys() - before.keys()),
            "removed": sorted(before.keys() - after.keys()),
            "changed": sorted(key for key in before.keys() & after.keys()
                              if before[key] != after[key])}


def _workbook_validation(path: Path, original: Path | None, package: OfficePackage | None = None) -> int:
    result = {"status": "skipped-no-xsd", "structural_check": "failed"}
    try:
        if package is None:
            package = resolve_package(path)
        parts, rels = _spreadsheet_package(path, package, fingerprint=original is not None)
        if original is not None:
            try:
                old_parts, old_rels = _spreadsheet_package(original, resolve_package(original), fingerprint=True)
            except UnsupportedLayout:
                raise
            except Exception as exc:
                raise ValueError(f"original package: {exc}") from exc
            result["part_diff"] = _changes(old_parts, parts)
            result["relationship_diff"] = {
                change: [{"part": part, "id": rel_id,
                          "before": old_rels.get((part, rel_id)),
                          "after": rels.get((part, rel_id))} for part, rel_id in keys]
                for change, keys in _changes(old_rels, rels).items()
            }
    except UnsupportedLayout:
        raise
    except Exception as exc:
        result["error"] = str(exc)
        return out_json(result) or 1
    result.update(structural_check="passed", part_count=len(parts), relationship_count=len(rels))
    return out_json(result)


def _run_office_validator(*, docx_delta=False) -> None:
    """Register macro-enabled suffixes and preserve baseline-aware DOCX checks."""
    sys.path.insert(0, str(TOOLS / "office"))
    from office import validate

    validate.OOXML_FAMILY.update({".docm": "docx", ".pptm": "pptx"})
    if not docx_delta:
        validate.main()
        return

    base_validator = validate.DOCXSchemaValidator
    relationship_detail = re.compile(
        r"^  (.+?): Line \d+: (Broken reference to .+|Duplicate relationship ID .+|"
        r"<[^>]+> r:(?:id|embed|link) references non-existent relationship .+?)(?: \(valid IDs: .*\))?$"
    )

    def capture(check):
        with redirect_stdout(io.StringIO()) as output:
            passed = check()
        return passed, output.getvalue()

    def finding_key(line):
        if line.startswith("  Unreferenced file: "):
            return line
        match = relationship_detail.fullmatch(line)
        if match:
            return match.groups()
        return None

    class DeltaValidator(base_validator):
        def validate(self):
            with tempfile.TemporaryDirectory(prefix="scient-docx-baseline-") as work:
                original_dir = Path(work)
                validate._unpack(self.original_file, original_dir)
                self.baseline = base_validator(original_dir)
                return super().validate()

        def check_relationship_delta(self, name, description):
            passed, report = capture(getattr(super(), name))
            if passed:
                print(report, end="")
                return True
            _, original_report = capture(getattr(self.baseline, name))
            known = Counter(key for line in original_report.splitlines() if (key := finding_key(line)))
            details = [line for line in report.splitlines() if line.startswith("  ")]
            if not details:
                print(report, end="")
                return False
            new = []
            for line in details:
                key = finding_key(line)
                if known[key]:
                    known[key] -= 1
                    print(f"Pre-existing {description}: {line.strip()}")
                else:
                    new.append(line)
            if new:
                print(f"FAILED - Found {len(new)} new {description} error(s):")
                print("\n".join(new))
            return not new

        def validate_file_references(self):
            return self.check_relationship_delta("validate_file_references", "relationship validation")

        def validate_all_relationship_ids(self):
            return self.check_relationship_delta("validate_all_relationship_ids", "relationship ID reference")

    # The adopted CLI also runs XSD and optional tracked-change validation.
    validate.DOCXSchemaValidator = DeltaValidator
    validate.main()


def _validate(path, original, author, family, package=None) -> int:
    if family not in {"docx", "xlsx", "pptx", ".pdf"}:
        resolve_package(path)
        raise ValueError(f"no validator for {path.suffix}; convert to OOXML/PDF first")
    if original is not None and OOXML_FAMILIES.get(original.suffix.lower(), original.suffix.lower()) != family:
        raise ValueError("target and --original must have the same document family")
    if author is not None and (family != "docx" or original is None):
        raise ValueError("--author requires a DOCX family target and --original")
    if family == "xlsx":
        return _workbook_validation(path, original, package)
    if package is None:
        resolve_package(path)
    if original is not None:
        resolve_package(original)
    if family == ".pdf":
        result = run(["qpdf", "--check", str(path)])
        # qpdf exit 3 = warnings only (normal for many published PDFs); 2 = errors.
        status = {0: "passed", 3: "passed-with-warnings"}.get(result.returncode, "failed")
        print(json.dumps({"file": str(path), "status": status, "qpdf_exit": result.returncode,
                          "diagnostics": (result.stdout + result.stderr).strip()[-4000:]}, indent=2))
        return 0 if status != "failed" else (result.returncode or 1)
    else:
        docx_delta = family == "docx" and original is not None
        cmd = [sys.executable, "-B", "-c",
               f"from doc import _run_office_validator; _run_office_validator(docx_delta={docx_delta})"]
        cmd.append(str(path))
        if original is not None:
            cmd.extend(("--original", str(original)))
        if author is not None:
            cmd.extend(("--author", author))
        result = run(cmd, cwd=str(TOOLS))
    print(result.stdout, end="")
    print(result.stderr, end="", file=sys.stderr)
    return result.returncode


def cmd_validate(args) -> int:
    path = Path(args.file).resolve()
    original = Path(args.original).resolve() if args.original else None
    suffix = path.suffix.lower()
    return _validate(path, original, args.author, OOXML_FAMILIES.get(suffix, suffix))


# ---------------------------------------------------------------- recalc
def _workbook_cells(path, package, *, data_only):
    from openpyxl import load_workbook

    with closing(load_workbook(path, read_only=True, data_only=data_only, keep_links=False)) as book:
        _check_sheet_inventory(book, package)
        for sheet in book.worksheets:
            with _sheet_parser(sheet) as parser:
                for cell in _stored_cells(sheet, parser):
                    yield sheet.title, cell


def _run_recalc_helper() -> None:
    """Use the adopted recalc CLI with a locked-down profile and typed error reporting."""
    import recalc

    setup = recalc.setup_libreoffice_macro

    def setup_profile(profile, timeout=30):
        # Trust the application macro installed in this scratch profile. Input
        # workbooks live outside its macro directories and have no trusted locations.
        _configure_soffice(profile, app_macro=True)
        return setup(profile, timeout=timeout)

    def scan_report(path):
        package = resolve_package(Path(path), recalc=True)
        errors = {error: [] for error in recalc.EXCEL_ERRORS}
        for sheet, cell in _workbook_cells(path, package, data_only=True):
            if cell.data_type == "e":
                errors.setdefault(cell.value or "empty error value", []).append(
                    f"{sheet}!{cell.coordinate}"
                )
        formulas = sum(cell.data_type == "f" for _, cell in _workbook_cells(path, package, data_only=False))
        return errors, formulas

    recalc.setup_libreoffice_macro = setup_profile
    # Both adopted scan paths use substring matching on strings. Feed the
    # same report builder typed errors while preserving its formula diagnostics.
    recalc._scan_xml = recalc._scan_with_openpyxl = scan_report
    recalc.main()


def _typed_recalc_errors(path: Path, package: OfficePackage) -> dict:
    count, locations = 0, []
    for sheet, cell in _workbook_cells(path, package, data_only=True):
        if cell.data_type == "e":
            count += 1
            if len(locations) < 100:
                locations.append({"sheet": sheet, "cell": cell.coordinate, "error": cell.value})
    return {"count": count, "locations": locations}


def cmd_recalc(args) -> int:
    path = Path(args.file).resolve()
    if args.timeout <= 0:
        raise ValueError("--timeout must be a positive integer")
    try:
        package = resolve_package(path, recalc=True)
        if OOXML_FAMILIES.get(path.suffix.lower()) != "xlsx":
            raise ValueError("recalc requires an XLSX family workbook")
        with tempfile.TemporaryDirectory(prefix=".scient-recalc-", dir=path.parent) as work:
            staged = Path(work) / path.name
            shutil.copy2(path, staged)
            return _recalc_staged(path, staged, package, args.timeout)
    except UnsupportedLayout as exc:
        return _layout_error(exc)


def _file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").digest()


def _recalc_staged(path, staged, package, timeout):
    before_missing = {"count": 0, "locations": []}
    _spreadsheet_package(staged, package, verify_parts=False, missing_caches=before_missing)
    before_digest = _file_digest(staged)
    result = run([sys.executable, "-B", "-c", "from doc import _run_recalc_helper; _run_recalc_helper()",
                  str(staged), str(timeout)], cwd=str(TOOLS), timeout=timeout + 30)
    print(result.stderr, file=sys.stderr, end="")
    try:
        report = json.loads(result.stdout)
        if not isinstance(report, dict):
            raise ValueError("expected a JSON object")
        if "error" not in report:
            if not isinstance(report.get("status"), str) or type(report.get("total_errors")) is not int:
                raise ValueError("expected status and integer total_errors")
    except ValueError as exc:
        return out_json({"error": f"malformed recalc JSON: {exc}",
                         "stdout": result.stdout[-2000:]}) or 3

    missing = {"count": 0, "locations": []}
    try:
        updated = resolve_package(staged, recalc=True)
        _spreadsheet_package(staged, updated, verify_parts=False, missing_caches=missing)
        if missing["count"]:
            report["missing_caches"] = missing
        unchanged = _file_digest(staged) == before_digest
        if before_missing["count"] and unchanged:
            report["file_unchanged"] = True
        if "error" in report:
            return out_json(report) or 2
        typed = _typed_recalc_errors(staged, updated)
    except UnsupportedLayout:
        raise
    except Exception as exc:
        report["typed_scan_error"] = str(exc)
        return out_json(report) or 2
    if typed["count"]:
        report["typed_errors"] = typed
    remaining = report.get("not_computed")
    if isinstance(remaining, dict):
        remaining = any(remaining.values())
    if report["status"] == "success" and (missing["count"] or report.get("file_unchanged")):
        report["status"] = "incomplete"
    passed = (result.returncode == 0 and report["status"] == "success"
              and report["total_errors"] == 0 and not remaining and not typed["count"])
    if not unchanged:
        if _file_digest(path) != before_digest:
            raise ValueError("input workbook changed during recalculation")
        staged.replace(path)
    out_json(report)
    return 0 if passed else 2


# ---------------------------------------------------------------- text
def cmd_text(args) -> int:
    path = Path(args.file).resolve()
    package = resolve_package(path, check_pdf_pages=False)
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        report, pages = _read_pdf(path)
        report["text"] = _limit_text("\n\n".join(pages), args.max)
        return out_json(report)
    if OOXML_FAMILIES.get(suffix) == "docx":
        with _word_reader_input(path, package) as staged:
            md = _extract_text(staged)
            # Compare whole paragraphs, not substrings: a box saying "Scope" is not captured
            # by a body heading "Overview of Scope". Strip Markdown block markers first.
            captured = {re.sub(r"^\s*(?:#+|[-*+]|\d+[.)])\s+", "", line).replace("\\", "").strip()
                        for line in md.splitlines()}
            missing = [t for t in _docx_text_box_paragraphs(staged) if t not in captured]
        if missing:
            # markitdown/pandoc skip text boxes that Word and LibreOffice render.
            md += "\n\n## Text boxes\n\n" + "\n\n".join(missing) + "\n"
    else:
        md = _extract_text(path)
    print(_limit_text(md, args.max))
    return 0


def _docx_text_box_paragraphs(path) -> list[str]:
    """Paragraph texts inside w:txbxContent of the (already branch-selected) main part."""
    from docx import Document
    from docx.oxml.ns import qn

    body = Document(str(path)).element.body
    texts = []
    for box in body.iter(qn("w:txbxContent")):
        for p_el in box.iter(qn("w:p")):
            text = "".join(t.text or "" for t in p_el.iter(qn("w:t"))).strip()
            if text:
                texts.append(text)
    return texts


def _extract_text(path):
    try:
        from markitdown import MarkItDown

        md = MarkItDown(enable_plugins=False).convert(str(path)).markdown
    except Exception as exc:
        if path.suffix.lower() != ".docx":
            raise
        result = run(["pandoc", "--sandbox", "-t", "markdown", str(path)])
        if result.returncode != 0:
            raise RuntimeError(f"pandoc text fallback failed: {result.stderr.strip()[-800:]}") from exc
        md = result.stdout
    return md


def _limit_text(text, limit):
    if limit and len(text) > limit:
        return text[:limit] + f"\n\n…[truncated at {limit} chars; quick-look only — use inspect for edits]"
    return text


# ---------------------------------------------------------------- convert
PANDOC_OK = {".md", ".markdown", ".html", ".htm", ".docx", ".odt", ".epub",
             ".tex", ".latex", ".rst", ".org", ".txt"}


def _csv_value(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        micros = (value.days * 86400 + value.seconds) * 1_000_000 + value.microseconds
        seconds, fraction = divmod(abs(micros), 1_000_000)
        days, seconds = divmod(seconds, 86400)
        hours, seconds = divmod(seconds, 3600)
        minutes, seconds = divmod(seconds, 60)
        sign = "-" if micros < 0 else ""
        day_part = f"{days}D" if days else ""
        hour_part = f"{hours}H" if hours else ""
        minute_part = f"{minutes}M" if minutes else ""
        second_part = f"{seconds}.{fraction:06d}".rstrip("0") if fraction else str(seconds)
        return f"{sign}P{day_part}T{hour_part}{minute_part}{second_part}S"
    return str(value)


def _xlsx_to_csvs(src: Path, dst: Path, scratch: Path, package: OfficePackage) -> tuple[list[tuple[str, Path]], list[str], int]:
    """Plan dense CSV bytes from stored cells, then stage the outputs."""
    import csv
    from openpyxl.chartsheet import Chartsheet
    from openpyxl.reader.excel import ExcelReader

    _spreadsheet_package(src, package, verify_parts=False)

    class CSVWorkbookReader(ExcelReader):
        def read_chartsheet(self, sheet, rel):
            # Keep sheet positions for local defined names. Chart drawings
            # do not participate in a worksheet export.
            chart_sheet = Chartsheet(parent=self.wb, title=sheet.name)
            chart_sheet.sheet_state = sheet.state
            self.wb._sheets.append(chart_sheet)

    def read_book(*, data_only):
        reader = CSVWorkbookReader(src, read_only=True, data_only=data_only, keep_links=False)
        try:
            reader.read()
        except Exception:
            reader.archive.close()
            raise
        return reader.wb

    planned, missing, projected = [], 0, 0
    with closing(read_book(data_only=True)) as wb, closing(read_book(data_only=False)) as wf:
        _check_sheet_inventory(wb, package)
        _check_sheet_inventory(wf, package)
        worksheets = wb.worksheets
        if not worksheets:
            raise ValueError("workbook has no worksheets to export")
        for ordinal, (ws, formula_sheet) in enumerate(zip(worksheets, wf.worksheets, strict=True), 1):
            max_row = max_col = text_bytes = size = 0
            with _sheet_parser(ws) as value_parser, _sheet_parser(formula_sheet) as formula_parser:
                cached_cells = _stored_cells(ws, value_parser)
                formula_cells = _stored_cells(formula_sheet, formula_parser)
                for cached, formula in zip(cached_cells, formula_cells, strict=True):
                    row, col = cached.row, cached.column
                    if (row, col) != (formula.row, formula.column) or not (1 <= row <= 1048576 and 1 <= col <= 16384):
                        raise ValueError(f"invalid worksheet {ws.title!r} cell coordinates: {row}, {col}")
                    max_row, max_col = max(max_row, row), max(max_col, col)
                    missing += formula.data_type == "f" and cached.value is None
                    value = _csv_value(cached.value)
                    if value:
                        text_bytes += len(value.encode("utf-8"))
                        if any(ch in value for ch in ',"\r\n'):
                            text_bytes += value.count('"') + 2
                    # Commas and CRLF dominate for sparse sheets. A single
                    # blank field also needs quotes.
                    size = text_bytes + max_row * (max_col + (3 if max_col == 1 else 1))
                    if projected + size > CSV_MAX_BYTES:
                        raise ValueError(f"worksheet {ws.title!r} exceeds the projected CSV size budget "
                                         f"({CSV_MAX_BYTES:,} bytes across the workbook)")
            projected += size
            safe = re.sub(r"[^A-Za-z0-9._-]+", "_", ws.title).strip("_") or "sheet"
            name = dst.name if len(worksheets) == 1 else f"{dst.stem}--{ordinal:02d}-{safe}{dst.suffix}"
            planned.append((ws, max_row, max_col, scratch / name))

        for ws, max_row, max_col, output in planned:
            with output.open("w", newline="", encoding="utf-8") as fh, _sheet_parser(ws) as parser:
                writer = csv.writer(fh)
                blank = [""] * max_col
                written = 0
                for row, cells in groupby(_stored_cells(ws, parser), key=lambda cell: cell.row):
                    if not written < row <= max_row:
                        raise ValueError(f"worksheet {ws.title!r} has out-of-order rows")
                    for _ in range(written + 1, row):
                        writer.writerow(blank)
                    values = blank.copy()
                    for cell in cells:
                        values[cell.column - 1] = _csv_value(cell.value)
                    writer.writerow(values)
                    written = row
    notes = [f"one CSV per worksheet ({len(planned)}); cached formula values at full precision; "
             "dates, times and durations use ISO 8601; formulas, formats, charts and merged-cell "
             "layout are not represented"]
    if missing:
        notes.append(f"{missing} formula cells had no cached value (exported blank): run `doc.py recalc` first")
    return [(ws.title, output) for ws, _, _, output in planned], notes, missing


def _publish_csvs(staged: list[tuple[str, Path]], directory: Path, scratch: Path) -> list[dict[str, str]]:
    outputs = [{"sheet": title, "path": str(directory / path.name)} for title, path in staged]
    destinations = [Path(entry["path"]) for entry in outputs]
    backups = {}
    with tempfile.TemporaryDirectory(prefix=".backup-", dir=scratch) as saved:
        for index, target in enumerate(destinations):
            try:
                mode = target.lstat().st_mode
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(mode):
                raise ValueError(f"conversion needs a regular destination file: {target}")
            backups[target] = Path(saved) / str(index)
            os.link(target, backups[target])
        published = []
        try:
            for (_, staged_file), target in zip(staged, destinations, strict=True):
                staged_file.replace(target)
                published.append(target)
        except OSError:
            for target in reversed(published):
                if target in backups:
                    backups[target].replace(target)
                else:
                    target.unlink()
            raise
    return outputs


class _HTMLImages(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sources = []

    def handle_starttag(self, tag, attrs):
        if tag == "img":
            self.sources.append(dict(attrs).get("src") or "")


def _markup_images(path: Path):
    html = _HTMLImages()
    if path.suffix.lower() in (".html", ".htm"):
        html.feed(path.read_text(encoding="utf-8"))
    else:
        result = run(["pandoc", "--sandbox", "-f", "markdown", "-t", "json", str(path)])
        if result.returncode:
            raise ValueError(f"could not check Markdown image links: {result.stderr.strip()}")

        def images(node):
            if isinstance(node, list):
                for child in node:
                    yield from images(child)
            elif isinstance(node, dict):
                if node.get("t") == "Image":
                    yield node["c"][2][0]
                elif node.get("t") in ("RawBlock", "RawInline") and node["c"][0] == "html":
                    html.feed(node["c"][1])
                else:
                    yield from images(list(node.values()))

        yield from images(json.loads(result.stdout))
    html.close()
    yield from html.sources


def _missing_markup_images(staged: Path, dst: Path, media: Path) -> list[str]:
    missing = []
    for source in dict.fromkeys(_markup_images(staged)):
        uri = urlsplit(source)
        if uri.scheme not in ("", "file") or (not uri.scheme and uri.netloc):
            continue
        path = Path(unquote(uri.path))
        if uri.scheme == "file" and (uri.netloc not in ("", "localhost") or not path.is_absolute()):
            missing.append(source)
            continue
        if path.is_absolute() and path.is_file():
            continue
        if uri.path and not path.is_absolute() and ".." not in path.parts and path.is_relative_to(media):
            if (staged.parent / path).is_file():
                continue
        if uri.path and not path.is_absolute() and (dst.parent / path).is_file():
            continue
        missing.append(source)
    return missing


def _publish_markup(staged: Path, dst: Path, media: Path) -> Path | None:
    media_source = staged.parent / media
    if not media_source.is_dir():
        staged.replace(dst)
        return None

    # A fresh subdirectory keeps links in earlier or same-stem outputs valid.
    media_target = dst.parent / media
    created_parent, moved = False, False
    try:
        try:
            media_target.parent.mkdir()
            created_parent = True
        except FileExistsError:
            if media_target.parent.is_symlink() or not media_target.parent.is_dir():
                raise ValueError(f"conversion needs a media directory: {media_target.parent}")
        media_source.rename(media_target)
        moved = True
        staged.replace(dst)
    except OSError:
        if moved:
            media_target.rename(media_source)
        if created_parent:
            with suppress(OSError):
                media_target.parent.rmdir()
        raise
    return media_target


def cmd_convert(args) -> int:
    src, dst = Path(args.src).resolve(), Path(args.dst).resolve()
    package = resolve_package(src)
    if dst.is_dir() or not dst.suffix:
        raise ValueError(f"conversion needs a destination file with an extension: {dst}")
    src_ext, dst_ext = src.suffix.lower(), dst.suffix.lower()
    use_csv = OOXML_FAMILIES.get(src_ext) == "xlsx" and dst_ext == ".csv"
    extract_media = (OOXML_FAMILIES.get(src_ext) == "docx" or src_ext == ".odt") and dst_ext in (
        ".md", ".markdown", ".html", ".htm"
    )
    markup = {".md", ".markdown", ".html", ".htm", ".tex", ".latex", ".rst", ".org",
              ".txt", ".epub"}
    # Pandoc re-creates documents semantically and silently dropped a real
    # ODT agenda table (CT10 audit). Use LibreOffice for Office-to-Office.
    use_pandoc = extract_media or (
        src_ext in PANDOC_OK and dst_ext in PANDOC_OK and (src_ext in markup or dst_ext in markup)
    )
    reference = None
    if args.reference_doc is not None:
        reference = Path(args.reference_doc).resolve()
        if not reference.is_file():
            raise ValueError(f"--reference-doc requires an existing file: {reference}")
        if not use_pandoc or dst_ext not in (".docx", ".odt"):
            route = "openpyxl-csv" if use_csv else "pandoc" if use_pandoc else "soffice"
            raise ValueError(f"--reference-doc is unsupported for the {route} route to {dst_ext}")
        resolve_package(reference)

    dst.parent.mkdir(parents=True, exist_ok=True)
    details = {}
    with tempfile.TemporaryDirectory(prefix=".scient-convert-", dir=dst.parent) as work:
        scratch = Path(work)
        if use_csv:
            staged_files, notes, missing = _xlsx_to_csvs(src, dst, scratch, package)
            for _, staged in staged_files:
                resolve_package(staged, expected_suffix=".csv")
            outputs = _publish_csvs(staged_files, dst.parent, scratch)
            return out_json({"src": str(src), "dst": [entry["path"] for entry in outputs],
                             "route": "openpyxl-csv", "sheet_outputs": outputs,
                             "missing_caches": missing, "fidelity_notes": notes})
        media = None
        if use_pandoc:
            staged = scratch / dst.name
            command = ["pandoc", "--sandbox", str(src), "-o", str(staged), "--standalone"]
            if reference is not None:
                command.append(f"--reference-doc={reference}")
            if extract_media:
                media = Path(f"{dst.stem}_media") / uuid4().hex
                command.append(f"--extract-media={media}")
                if OOXML_FAMILIES.get(src_ext) == "docx":
                    command.append("--from=docx")
            result = run(command, cwd=scratch) if media is not None else run(command)
            warnings = result.stderr.strip().splitlines()
            try:
                _check_output(staged, result, "pandoc")
            except RuntimeError as exc:
                return out_json({"error": str(exc), "warnings": warnings}) or 1
            details = {"warnings": warnings,
                       "incomplete": any(re.match(r"\[WARNING\]\s+Could not fetch resource\b", line)
                                         for line in warnings)}
            if media is not None and (missing_images := _missing_markup_images(staged, dst, media)):
                details.update(incomplete=True, missing_images=missing_images)
            notes = ["pandoc conversion: semantic re-creation, not a copy. Tracked changes are "
                     "accepted (flattened), comments/macros/content controls dropped, page layout "
                     "comes from --reference-doc or pandoc defaults"]
            if OOXML_FAMILIES.get(src_ext) == "docx" or src_ext == ".odt":
                notes.append("Word/ODT source: drawings, charts, text boxes, SmartArt and some "
                             "tables can be lost; equations survive only as OMML<->TeX; verify "
                             "with render-diff and docx_feature_inventory --compare (CT10: 29->50 "
                             "pages, equations/diagrams lost on a real report)")
            route = "pandoc"
        else:
            staged = soffice_convert(src, dst.suffix.lower().lstrip("."), scratch)
            notes = ["LibreOffice conversion; layout is approximated by LibreOffice (overlaps "
                     "possible), tracked changes kept but may be re-split; verify with render"]
            route = "soffice"
        problems = []
        if details.get("incomplete"):
            problems.append("missing resources (see warnings)")
        try:
            staged_package = resolve_package(staged, expected_suffix=dst_ext)
            if staged_package is not None:
                with redirect_stdout(io.StringIO()) as report, redirect_stderr(report):
                    validation = _validate(staged, None, None, OOXML_FAMILIES[dst_ext], staged_package)
                details["validation"] = {"exit": validation, "report_tail": report.getvalue().strip()[-1500:]}
        except UnsupportedLayout as exc:
            return out_json({"code": "unsupported-layout", "error": str(exc),
                             "src": str(src), "dst": None, "route": route, "published": False}) or 3
        except (zipfile.BadZipFile, ValueError) as exc:
            if dst_ext not in OOXML_FAMILIES:
                raise
            details["validation"] = {"exit": 1, "report_tail": str(exc)}
            return out_json({"src": str(src), "dst": None, "route": route, "published": False,
                             "incomplete": True, "problems": ["output fails the package gate"],
                             "fidelity_notes": notes, **details}) or 2
        if "validation" in details:
            if details["validation"]["exit"] != 0:
                problems.append("output fails `doc.py validate`")
                details["incomplete"] = True
        if problems and not args.keep_incomplete:
            return out_json({"src": str(src), "dst": None, "route": route, "published": False,
                             "problems": problems, "fidelity_notes": notes, **details,
                             "hint": "not published; rerun with --keep-incomplete to keep it "
                                     "for inspection"}) or 2
        if media is None:
            staged.replace(dst)
        elif published_media := _publish_markup(staged, dst, media):
            details["media"] = str(published_media)
    rc = 2 if problems else 0
    out_json({"src": str(src), "dst": str(dst), "route": route, "published": True,
              "problems": problems, "fidelity_notes": notes, **details})
    return rc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe").set_defaults(fn=cmd_probe)
    p = sub.add_parser("inspect"); p.add_argument("file"); p.set_defaults(fn=cmd_inspect)
    p = sub.add_parser("text"); p.add_argument("file"); p.add_argument("--max", type=int, default=20000); p.set_defaults(fn=cmd_text)
    p = sub.add_parser("render"); p.add_argument("file"); p.add_argument("--out", required=True)
    p.add_argument("--pdf", action="store_true"); p.add_argument("--dpi", type=int, default=130); p.set_defaults(fn=cmd_render)
    p = sub.add_parser("render-diff"); p.add_argument("a"); p.add_argument("b"); p.add_argument("--out", required=True)
    p.add_argument("--dpi", type=int, default=110); p.set_defaults(fn=cmd_render_diff)
    p = sub.add_parser("validate"); p.add_argument("file"); p.add_argument("--original"); p.add_argument("--author"); p.set_defaults(fn=cmd_validate)
    p = sub.add_parser("recalc"); p.add_argument("file"); p.add_argument("--timeout", type=int, default=60); p.set_defaults(fn=cmd_recalc)
    p = sub.add_parser("convert"); p.add_argument("src"); p.add_argument("dst"); p.add_argument("--reference-doc")
    p.add_argument("--keep-incomplete", action="store_true",
                   help="publish a supported output with missing resources or validation failures (exit 2)")
    p.set_defaults(fn=cmd_convert)
    args = ap.parse_args()
    try:
        return args.fn(args)
    except UnsupportedLayout as exc:
        return _layout_error(exc)
    except PDFReadError as exc:
        return out_json({"error": str(exc), "diagnostics": exc.diagnostics}) or 1
    except subprocess.TimeoutExpired as exc:
        return out_json({"error": f"{Path(exc.cmd[0]).name} timed out after {exc.timeout}s"}) or 1
    except Exception as exc:  # Document parsers and subprocesses share this CLI error surface.
        return out_json({"error": f"{type(exc).__name__}: {exc}"}) or 1


if __name__ == "__main__":
    raise SystemExit(main())
