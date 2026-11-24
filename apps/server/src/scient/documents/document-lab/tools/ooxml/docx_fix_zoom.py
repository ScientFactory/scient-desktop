"""Fill a missing w:percent on existing Word zoom settings."""

import argparse
from copy import copy
import os
from pathlib import Path
import shutil
import stat
import tempfile
import zipfile

from defusedxml.ElementTree import ParseError
from defusedxml.common import DefusedXmlException
from lxml import etree

from docx_feature_inventory import (
    STRICT_RELS, STRICT_WORD_NS, TRANSITIONAL_RELS, WORD_NS,
    check_zip_members, part_key, read_relationships, relationship_target, relationships_path,
)


ZOOM_DEFAULTS = {WORD_NS: "100", STRICT_WORD_NS: "100%"}


def settings_entry(archive, entries):
    root_rels = entries.get(relationships_path(""))
    if root_rels is None:
        raise ValueError("package is missing _rels/.rels")
    bases = (TRANSITIONAL_RELS, STRICT_RELS)
    office = [rel for rel in read_relationships(archive, root_rels)
              if rel.get("Type") in {f"{base}/officeDocument" for base in bases}]
    if len(office) != 1:
        raise ValueError("expected exactly one officeDocument relationship")
    main = relationship_target("", office[0].attrib)
    if main not in entries:
        raise ValueError(f"missing or unsupported officeDocument target: {office[0].get('Target')!r}")
    document_rels = entries.get(relationships_path(main))
    if document_rels is None:
        return None
    settings = [rel for rel in read_relationships(archive, document_rels)
                if rel.get("Type") in {f"{base}/settings" for base in bases}]
    if not settings:
        return None
    if len(settings) != 1:
        raise ValueError("expected at most one Word settings relationship")
    target = relationship_target(main, settings[0].attrib)
    if target not in entries:
        raise ValueError(f"missing or unsupported Word settings target: {settings[0].get('Target')!r}")
    return entries[target]


def patch_settings(data: bytes) -> bytes | None:
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
    root = etree.fromstring(data, parser)
    tree = root.getroottree()
    if tree.docinfo.doctype:
        raise ValueError("DOCTYPE is not allowed in Word settings")

    name = etree.QName(root)
    namespace = name.namespace
    if name.localname != "settings" or namespace not in ZOOM_DEFAULTS:
        raise ValueError("Word settings relationship does not point to a w:settings part")
    changed = False
    percent = f"{{{namespace}}}percent"
    for zoom in root.findall(f"{{{namespace}}}zoom"):
        if percent not in zoom.attrib:
            zoom.set(percent, ZOOM_DEFAULTS[namespace])
            changed = True

    if changed:
        return etree.tostring(tree, encoding=tree.docinfo.encoding, xml_declaration=True)
    return None


def fix_zoom(source: Path, output: Path) -> bool:
    source, output = source.resolve(), output.resolve()
    temporary = None
    try:
        with source.open("rb") as source_file, zipfile.ZipFile(source_file) as archive:
            check_zip_members(archive)
            entries = archive.infolist()
            patched = None
            settings = settings_entry(archive, {
                part_key(entry.filename): entry for entry in entries if not entry.is_dir()
            })
            if settings is not None:
                if settings.file_size > 16 * 1024 * 1024:
                    raise ValueError("Word settings exceed 16 MiB")
                patched = patch_settings(archive.read(settings))

            if patched is None and source == output:
                return False

            with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as staged:
                temporary = Path(staged.name)
                if patched is None:
                    source_file.seek(0)
                    shutil.copyfileobj(source_file, staged)
                else:
                    with zipfile.ZipFile(staged, "w") as rewritten:
                        rewritten.comment = archive.comment
                        for entry in entries:
                            if entry is settings:
                                rewritten.writestr(copy(entry), patched)
                            else:
                                with (
                                    archive.open(entry) as member,
                                    rewritten.open(copy(entry), "w") as target,
                                ):
                                    shutil.copyfileobj(member, target)

        mode_source = output if output.exists() else source
        temporary.chmod(stat.S_IMODE(mode_source.stat().st_mode) & 0o777)
        os.replace(temporary, output)
        return patched is not None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Word package to patch in place")
    parser.add_argument("-o", "--output", type=Path, help="write to a separate Word package")
    args = parser.parse_args()
    output = args.output or args.input
    try:
        changed = fix_zoom(args.input, output)
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, etree.XMLSyntaxError,
            ParseError, DefusedXmlException) as error:
        parser.exit(1, f"Error: {error}\n")
    print(f"{output}: {'set missing zoom percentages' if changed else 'no zoom repair needed'}")


if __name__ == "__main__":
    main()
