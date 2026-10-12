interface Edge {
  horizontal: boolean;
  at: number;
  from: number;
  to: number;
  real: boolean;
}

/** Fill only missing rendered borders, including partially ruled merged cells. */
export function installLatexTableEditingGuides(root: HTMLElement): () => void {
  const svg = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("scient-latex-table-guides");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "none");
  const path = root.ownerDocument.createElementNS(svg.namespaceURI, "path");
  svg.append(path);
  root.append(svg);
  root.setAttribute("data-table-guides", "");
  let frame = 0;
  let observedTable: HTMLTableElement | null = null;
  const paint = () => {
    frame = 0;
    const table = root.querySelector<HTMLTableElement>(".scient-latex-rich-table-scroll > table");
    if (table !== observedTable) {
      if (observedTable) resize.unobserve(observedTable);
      if (table) resize.observe(table);
      observedTable = table;
    }
    const bounds = root.getBoundingClientRect();
    if (!table || !bounds.width || !bounds.height) {
      path.removeAttribute("d");
      return;
    }
    const viewport = table.parentElement?.getBoundingClientRect() ?? bounds;
    const inset = [
      (viewport.top - bounds.top) / bounds.height,
      (bounds.right - viewport.right) / bounds.width,
      (bounds.bottom - viewport.bottom) / bounds.height,
      (viewport.left - bounds.left) / bounds.width,
    ].map((value) => `${Math.max(0, value) * 100}%`);
    svg.style.clipPath = `inset(${inset.join(" ")})`;
    const edges: Edge[] = [];
    const add = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const style = getComputedStyle(element);
      const sides = [
        ["Top", true, rect.top, rect.left, rect.right],
        ["Bottom", true, rect.bottom, rect.left, rect.right],
        ["Left", false, rect.left, rect.top, rect.bottom],
        ["Right", false, rect.right, rect.top, rect.bottom],
      ] as const;
      for (const [side, horizontal, at, from, to] of sides) {
        const borderStyle = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
        const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
        edges.push({
          horizontal,
          at,
          from,
          to,
          real: width > 0 && borderStyle !== "none" && borderStyle !== "hidden",
        });
      }
    };
    for (const cell of table.querySelectorAll<HTMLElement>("td,th")) {
      if (
        cell.closest("table") !== table ||
        cell.closest(
          '.scient-latex-table-page-gap,[data-latex-longtable-band="measurement"],.scient-latex-longtable-rule',
        )
      )
        continue;
      add(cell);
    }
    // A border on the table itself also supplies the corresponding outer edge.
    const cellCount = edges.length;
    add(table);
    const tolerance = Math.max(0.5, (bounds.width / (root.offsetWidth || 1)) * 0.5);
    const key = (edge: Edge, bucket = Math.round(edge.at / tolerance)) =>
      `${edge.horizontal ? "h" : "v"}:${bucket}`;
    const real = new Map<string, Edge[]>();
    for (const edge of edges) {
      if (!edge.real) continue;
      const list = real.get(key(edge)) ?? [];
      list.push(edge);
      real.set(key(edge), list);
    }
    const missing = new Map<string, { edge: Edge; parts: [number, number][] }>();
    for (const edge of edges.slice(0, cellCount)) {
      if (edge.real) continue;
      let parts: [number, number][] = [[edge.from, edge.to]];
      const bucket = Math.round(edge.at / tolerance);
      const adjacent = [-1, 0, 1].flatMap((delta) => real.get(key(edge, bucket + delta)) ?? []);
      for (const border of adjacent) {
        if (Math.abs(border.at - edge.at) > tolerance) continue;
        parts = parts.flatMap(([from, to]) => {
          if (border.to <= from || border.from >= to) return [[from, to] as [number, number]];
          const remaining: [number, number][] = [];
          if (border.from > from) remaining.push([from, border.from]);
          if (border.to < to) remaining.push([border.to, to]);
          return remaining;
        });
      }
      const group = missing.get(key(edge)) ?? { edge, parts: [] };
      group.parts.push(...parts);
      missing.set(key(edge), group);
    }
    const lines: string[] = [];
    for (const { edge, parts } of missing.values()) {
      // Shared missing edges paint once, so their opacity stays uniform.
      parts.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const part of parts) {
        const previous = merged.at(-1);
        if (previous && part[0] <= previous[1] + tolerance)
          previous[1] = Math.max(previous[1], part[1]);
        else merged.push([...part]);
      }
      for (const [from, to] of merged) {
        if (to - from < tolerance) continue;
        const at = edge.at - (edge.horizontal ? bounds.top : bounds.left);
        const start = from - (edge.horizontal ? bounds.left : bounds.top);
        const end = to - (edge.horizontal ? bounds.left : bounds.top);
        lines.push(edge.horizontal ? `M${start} ${at}H${end}` : `M${at} ${start}V${end}`);
      }
    }
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    path.setAttribute("d", lines.join(""));
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !svg.contains(record.target))) schedule();
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "colspan", "rowspan", "data-table-style"],
  });
  // Page zoom changes rendered geometry without changing the table's layout size.
  const stage = root.closest(".scient-latex-page-stage");
  if (stage) observer.observe(stage, { attributes: true, attributeFilter: ["style"] });
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  root.addEventListener("scroll", schedule, true);
  schedule();
  return () => {
    observer.disconnect();
    resize.disconnect();
    root.removeEventListener("scroll", schedule, true);
    cancelAnimationFrame(frame);
    root.removeAttribute("data-table-guides");
    svg.remove();
  };
}
