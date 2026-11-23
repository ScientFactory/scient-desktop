"""Remove undeclared plot axis references in a generated PPTX and revalidate."""

import argparse
from copy import copy
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

from lxml import etree

from docx_feature_inventory import check_zip_members

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
from office.helpers.pptx_chart import (
    _CHART_NAMESPACES,
    _CHART_PART_RE,
    _axis_key,
    _plot_area_children,
    axis_declarations,
)


def patch_chart(data):
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
    root = etree.fromstring(data, parser)
    tree = root.getroottree()
    if tree.docinfo.doctype:
        raise ValueError("DOCTYPE is not allowed in chart XML")

    removed = []
    for ns in _CHART_NAMESPACES:
        for area in root.iter(ns + "plotArea"):
            children = list(_plot_area_children(area))
            declared = dict(axis_declarations(children, ns))
            for plot in children:
                if not isinstance(plot.tag, str) or not plot.tag.startswith(ns) or not plot.tag.endswith("Chart"):
                    continue
                for reference in plot.findall(ns + "axId"):
                    value = reference.get("val")
                    if value is not None and _axis_key(value) not in declared:
                        plot.remove(reference)
                        removed.append(value)
    if removed:
        data = etree.tostring(tree, encoding=tree.docinfo.encoding, xml_declaration=True)
    return data, removed


def fix_chart_axes(source, output):
    if source.suffix.lower() != ".pptx" or output.suffix.lower() != ".pptx":
        raise ValueError("input and output must be .pptx files")
    if source.resolve() == output.resolve() or (output.exists() and source.samefile(output)):
        raise ValueError("choose a separate output deck")
    repairs = {}
    with TemporaryDirectory(dir=output.parent, prefix=".pptx-chart-axes-") as temp:
        staged = Path(temp) / "checked.pptx"
        with ZipFile(source) as package, ZipFile(staged, "w") as target:
            check_zip_members(package)
            target.comment = package.comment
            for entry in package.infolist():
                if _CHART_PART_RE.fullmatch(entry.filename):
                    data, removed = patch_chart(package.read(entry))
                    if removed:
                        repairs[entry.filename] = removed
                    target.writestr(copy(entry), data)
                else:
                    with package.open(entry) as member, target.open(copy(entry), "w") as destination:
                        shutil.copyfileobj(member, destination)

        subprocess.run([sys.executable, "-B", str(TOOLS / "doc.py"), "validate", str(staged)], check=True)
        staged.replace(output)
    for part, values in repairs.items():
        print(f"{part}: removed undeclared axId {', '.join(values)}")
    print(f"Published validated deck {output}")
    return repairs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        fix_chart_axes(args.input, args.output)
    except subprocess.CalledProcessError as error:
        parser.exit(error.returncode, "pptx_fix_chart_axes: validation failed\n")
    except (BadZipFile, OSError, ValueError, etree.XMLSyntaxError) as error:
        parser.exit(1, f"pptx_fix_chart_axes: {error}\n")


if __name__ == "__main__":
    main()
