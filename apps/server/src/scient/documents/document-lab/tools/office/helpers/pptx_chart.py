# Modified by Scient lab 2026-11-22: validate chart axes within each plot area and check stacked labels by XML namespace.
"""Find chart XML that PowerPoint refuses or repairs.

Detection only: more than one repair is usually valid, and only the author knows
which was meant.
"""


from __future__ import annotations

import html
import re
from collections import Counter
from typing import Mapping

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from . import part_text


_CHART_PART_RE = re.compile(r"ppt/charts/chart\d+\.xml")


def _strip_ext_lst(text: str) -> str:
    return _strip_outermost(text, "c:extLst")


def _strip_outermost(text: str, name: str) -> str:
    out, cursor = [], 0
    for lo, hi in _outermost_spans(text, name):
        out.append(text[cursor:lo])
        cursor = hi
    out.append(text[cursor:])
    return "".join(out)


STACKED_GROUPINGS = frozenset({"stacked", "percentStacked"})
LEGAL_ON_STACKED = ("ctr", "inEnd", "inBase")
_CHART_NAMESPACES = (
    "{http://schemas.openxmlformats.org/drawingml/2006/chart}",
    "{http://purl.oclc.org/ooxml/drawingml/chart}",
)
_AXIS_KINDS = ("catAx", "valAx", "serAx", "dateAx")
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"


_AXIS_COUNTS = {
    "barChart": (2, 2), "lineChart": (2, 2), "areaChart": (2, 2),
    "scatterChart": (2, 2), "bubbleChart": (2, 2), "radarChart": (2, 2),
    "stockChart": (2, 2), "bar3DChart": (2, 3), "area3DChart": (2, 3),
    "surfaceChart": (2, 3), "line3DChart": (3, 3), "surface3DChart": (3, 3),
}


def _axis_key(value: str) -> int | str:
    try:
        return int(value)
    except ValueError:
        return value


def _plot_area_children(area):
    for child in area:
        if child.tag == _MC + "AlternateContent":
            choice = child.find(_MC + "Choice")
            if choice is not None:
                yield from _plot_area_children(choice)
        else:
            yield child


def axis_declarations(children, namespace):
    axis_tags = {namespace + kind for kind in _AXIS_KINDS}
    return [
        (_axis_key(axis_id.attrib["val"]), _local(axis.tag))
        for axis in children if axis.tag in axis_tags
        for axis_id in axis.findall(namespace + "axId") if "val" in axis_id.attrib
    ]


def _check_chart_plots(part: str, xml: str) -> list[str]:
    root = _parse_chart(xml)
    if root is None:
        return []
    problems = []
    for ns in _CHART_NAMESPACES:
        for area in root.iter(ns + "plotArea"):
            children = list(_plot_area_children(area))
            declarations = axis_declarations(children, ns)
            declared = dict(declarations)
            duplicate_declarations = [str(i) for i, count in Counter(i for i, _ in declarations).items() if count > 1]
            if duplicate_declarations:
                problems.append(f"{part}: plotArea declares duplicate axId {', '.join(duplicate_declarations)}")
            for plot in children:
                if not plot.tag.startswith(ns) or not plot.tag.endswith("Chart"):
                    continue
                kind = _local(plot.tag)
                ids = [axis_id.get("val", "(missing val)") for axis_id in plot.findall(ns + "axId")]
                undeclared = list(dict.fromkeys(i for i in ids if _axis_key(i) not in declared))
                if undeclared:
                    problems.append(
                        f"{part}: <c:{kind}> references undeclared axId "
                        f"{', '.join(undeclared)} in its plotArea"
                    )
                minimum, maximum = _AXIS_COUNTS.get(kind, (0, 0))
                if not minimum <= len(ids) <= maximum:
                    count = str(minimum) if minimum == maximum else f"{minimum} to {maximum}"
                    problems.append(
                        f"{part}: <c:{kind}> has {len(ids)} axis references ({', '.join(ids)}), "
                        f"expected {count}"
                    )
                keys = [_axis_key(i) for i in ids]
                repeated = [str(i) for i, count in Counter(keys).items() if count > 1]
                if repeated:
                    problems.append(f"{part}: <c:{kind}> repeats axId {', '.join(repeated)}")
                if kind in {"barChart", "lineChart"} and not undeclared:
                    kinds = {declared[i] for i in keys}
                    if kinds not in ({"catAx", "valAx"}, {"dateAx", "valAx"}):
                        problems.append(
                            f"{part}: 2-D <c:{kind}> must reference a category or date axis and a value axis"
                        )
                if kind in {"barChart", "bar3DChart"}:
                    _check_stacked_labels(part, plot, kind, ns, problems)
    return problems


def _check_stacked_labels(part, plot, kind, ns, problems):
    grouping = plot.find(ns + "grouping")
    if grouping is None or grouping.get("val") not in STACKED_GROUPINGS:
        return
    labels = plot.findall(f"./{ns}dLbls") + plot.findall(f"./{ns}ser/{ns}dLbls")
    positions = [
        pos for label in labels
        for path in (f"./{ns}dLblPos", f"./{ns}dLbl/{ns}dLblPos")
        for pos in label.findall(path) if pos.get("val") == "outEnd"
    ]
    if positions:
        problems.append(
            f'{part}: {len(positions)} data label(s) use dLblPos="outEnd" on a '
            f'{grouping.get("val")} {kind}. Use {", ".join(LEGAL_ON_STACKED)}'
        )


def _shown(value: str) -> str:
    return '"' + repr(value[:20])[1:-1] + '"'


DECIMAL_SETTINGS = (
    "crossesAt", "max", "min", "majorUnit", "minorUnit", "logBase",
    "forward", "backward", "intercept", "x", "y", "w", "h",
    "splitPos", "custUnit", "pictureStackUnit",
)
_DECIMAL_SETTING_RE = re.compile(
    rf"""<c:({"|".join(DECIMAL_SETTINGS)})\b[^<>]*?\bval=["']([^"'<>]*)["']"""
)
_DECIMAL_RE = re.compile(
    r"[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?"
    r"|[+-]?(inf|infinity|nan(\(\w*\))?|\u221e|1\.#(inf|qnan|snan|ind)\d*)",
    re.IGNORECASE,
)


def _check_decimal_settings(part: str, xml: str) -> list[str]:
    problems = []
    for name, raw in sorted(set(_DECIMAL_SETTING_RE.findall(_strip_ext_lst(xml)))):
        value = html.unescape(raw)
        if _DECIMAL_RE.fullmatch(value.strip()):
            continue
        fix = "Fix: write a plain number, or remove the element"
        if name == "crossesAt" and value.strip() == "autoZero":
            fix = ("Fix: leave valAxisCrossesAt: 0 out of the pptxgenjs options, the axis "
                   "crosses at zero anyway. In the XML, write "
                   '<c:crosses val="autoZero"/> or a number')
        problems.append(
            f"{part}: <c:{name} val={_shown(value)}> is not a number, and PowerPoint "
            f"will offer to repair the deck. {fix}"
        )
    return problems


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _drawn_series(root) -> list:
    found, to_visit = [], [root]
    while to_visit:
        for child in to_visit.pop():
            name = _local(child.tag)
            if name == "ser":
                found.append(child)
            elif name == "AlternateContent":
                to_visit.extend(child[:1])
            elif name != "extLst":
                to_visit.append(child)
    return found


def _parse_chart(xml: str):
    try:
        return ElementTree.fromstring(xml.encode("utf-8", "surrogateescape"))
    except (ElementTree.ParseError, DefusedXmlException, LookupError, ValueError):
        return None


def _check_series_order(part: str, xml: str) -> list[str]:
    root = _parse_chart(xml)
    if root is None:
        return []
    orders = Counter()
    for series in _drawn_series(root):
        own = [c.get("val", "") for c in series if _local(c.tag) == "order"]
        if own and own[0].isascii() and own[0].isdigit():
            orders[own[0]] += 1
    repeated = sorted((o for o, n in orders.items() if n > 1), key=lambda o: (len(o), o))
    if not repeated:
        return []
    return [
        f"{part}: two or more series share the <c:order> value {', '.join(o[:12] for o in repeated)}, "
        f"and PowerPoint will offer to repair the deck. Fix: number <c:order> "
        f"(and <c:idx>) 0, 1, 2... across every series in the chart, a combo "
        f"chart's line series carrying on from its bars"
    ]


PRESET_DASHES = frozenset({
    "solid", "dot", "dash", "lgDash", "dashDot", "lgDashDot", "lgDashDotDot",
    "sysDash", "sysDot", "sysDashDot", "sysDashDotDot",
})
_PRESET_DASH_RE = re.compile(r"""<a:prstDash\b[^<>]*?\bval=["']([^"'<>]*)["']""")


def _check_preset_dashes(part: str, xml: str) -> list[str]:
    values = {html.unescape(v) for v in _PRESET_DASH_RE.findall(_strip_ext_lst(xml))}
    return [
        f"{part}: <a:prstDash val={_shown(value)}> is not a dash style, and PowerPoint "
        f"will offer to repair the deck. Use one of {', '.join(sorted(PRESET_DASHES))}. "
        f"In pptxgenjs, lineDash takes one such word for the whole chart, not an array"
        for value in sorted(values)
        if value.strip() not in PRESET_DASHES
    ]


def _outermost_spans(text: str, name: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    depth = 0
    start = 0
    for match in re.finditer(rf"<(/?){name}\b[^<>]*?(/?)>", text):
        closing, self_closing = match.group(1), match.group(2)
        if self_closing:
            continue
        if closing:
            if depth:
                depth -= 1
                if depth == 0:
                    spans.append((start, match.end()))
        else:
            if depth == 0:
                start = match.start()
            depth += 1
    return spans


CHART_CHECKS = (
    _check_chart_plots,
    _check_decimal_settings,
    _check_series_order,
    _check_preset_dashes,
)


_COMMENT_OR_PI_RE = re.compile(r"<!--.*?(?:-->|\Z)|<\?(?!xml\s).*?(?:\?>|\Z)", re.DOTALL)


def find_chart_problems(files: Mapping[str, bytes]) -> list[str]:
    problems: list[str] = []
    for part in sorted(n for n in files if _CHART_PART_RE.fullmatch(n)):
        xml = _strip_outermost(_COMMENT_OR_PI_RE.sub("", part_text(files[part])), "mc:Fallback")
        for check in CHART_CHECKS:
            problems.extend(check(part, xml))
    return problems
