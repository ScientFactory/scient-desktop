/** Browser measurements are immutable inputs; planning never reads or writes DOM. */
export interface PagedUnit {
  readonly key: object;
  readonly height: number;
  readonly gap: number;
  readonly keepWithNext?: boolean | undefined;
  readonly break?: "page" | "column" | undefined;
  readonly breakBefore?: boolean;
  readonly columns?: 1 | 2;
  readonly stretch?: boolean;
  readonly noteHeight?: number;
  readonly continuationHead?: number;
  readonly continuationFoot?: number;
  readonly shrink?: number;
  readonly gapShrink?: number;
  /** Final formula descenders may extend below the last baseline at a page boundary. */
  readonly depth?: number;
}

export interface PagedDimensions {
  readonly height: number;
  readonly gap: number;
  readonly top: number;
  readonly bottom: number;
}

interface FlowState {
  readonly page: number;
  readonly column: number;
  readonly columns: number;
  readonly origin: number;
  readonly cursor: number;
  readonly notes: number;
  readonly elastic: boolean;
}

export interface PagedPlacement {
  readonly top: number;
  readonly page: number;
  readonly column: number;
  readonly height: number;
  readonly continued: boolean;
  readonly gap?: number;
  readonly after: FlowState;
}

export interface PagedPlan {
  readonly dimensions: PagedDimensions;
  readonly units: readonly PagedUnit[];
  readonly placements: readonly PagedPlacement[];
  readonly pages: number;
  readonly visited: number;
  readonly labels?: readonly string[];
  readonly numbers?: readonly number[];
  readonly sheets?: readonly {
    top: number;
    left: number;
    width: number;
    height: number;
    landscape: boolean;
  }[];
}

const initial: FlowState = {
  page: 0,
  column: 0,
  columns: 1,
  origin: 0,
  cursor: 0,
  notes: 0,
  elastic: false,
};
const sameState = (a: FlowState, b: FlowState) =>
  a.page === b.page &&
  a.column === b.column &&
  a.columns === b.columns &&
  a.origin === b.origin &&
  Math.abs(a.cursor - b.cursor) < 0.01 &&
  Math.abs(a.notes - b.notes) < 0.01;

/** Resume before the first changed unit; reuse a suffix only with identical continuation state. */
export function* planPagedFlow(
  units: readonly PagedUnit[],
  dimensions: PagedDimensions,
  previous?: PagedPlan,
): Generator<void, PagedPlan> {
  const capacity = Math.max(1, dimensions.height - dimensions.top - dimensions.bottom);
  const stride = dimensions.height + dimensions.gap;
  const reusable =
    previous &&
    Object.keys(dimensions).every(
      (key) =>
        dimensions[key as keyof PagedDimensions] ===
        previous.dimensions[key as keyof PagedDimensions],
    );
  let prefix = 0;
  if (reusable) while (prefix < units.length && units[prefix] === previous.units[prefix]) prefix++;
  // A changed unit can alter the keep group immediately before it.
  if (prefix < units.length) while (prefix > 0 && units[prefix - 1]?.keepWithNext) prefix--;
  // Elastic skips can adjust earlier blocks on this page, so restart at its checkpoint.
  if (reusable && prefix < units.length && prefix > 0) {
    const boundary = previous.placements[prefix - 1]!;
    while (
      prefix > 0 &&
      previous.placements[prefix - 1]?.page === boundary.page &&
      previous.placements[prefix - 1]?.column === boundary.column
    )
      prefix--;
  }
  const placements: PagedPlacement[] = reusable ? previous.placements.slice(0, prefix) : [];
  let state = placements.at(-1)?.after ?? initial;
  let visited = 0;
  let suffix = units.length;
  if (reusable && previous.units.length === units.length)
    while (suffix > prefix && units[suffix - 1] === previous.units[suffix - 1]) suffix--;
  for (let index = prefix; index < units.length; index++) {
    if (
      reusable &&
      index >= suffix &&
      !state.elastic &&
      !previous.placements[index - 1]?.after.elastic &&
      sameState(state, previous.placements[index - 1]?.after ?? initial)
    ) {
      placements.push(...previous.placements.slice(index));
      break;
    }
    const unit = units[index]!;
    let { page, column, columns, origin, cursor, notes, elastic } = state;
    let continued = false;
    let placedGap = 0;
    const advance = (forcePage = false) => {
      if (!forcePage && columns === 2 && column === 0) column = 1;
      else {
        page++;
        column = 0;
        origin = 0;
      }
      cursor = origin;
      notes = 0;
      elastic = false;
      continued = true;
    };
    if (unit.columns !== undefined && unit.columns !== columns) {
      if (unit.columns === 1 && column === 1) {
        advance(true);
        cursor = 0;
      }
      columns = unit.columns;
      column = 0;
      origin = cursor;
    }
    if (unit.break) {
      if (cursor > origin + 0.01 || column > 0) advance(unit.break === "page");
    } else {
      if (unit.breakBefore && (cursor > origin + 0.01 || column > 0)) advance(true);
      // Oversized atomic content still makes progress; following content starts below it.
      if (cursor > capacity + 0.5) {
        page += Math.max(1, Math.ceil((cursor + dimensions.top) / stride));
        column = 0;
        origin = 0;
        cursor = 0;
        notes = 0;
        elastic = false;
        continued = true;
      } else if (cursor >= capacity - notes - 0.01) advance();
      let groupHeight = unit.height;
      let groupNotes = unit.noteHeight ?? 0;
      let group = index;
      while (
        units[group]?.keepWithNext &&
        units[group + 1] &&
        !units[group + 1]!.break &&
        units[group + 1]!.columns === undefined
      ) {
        group++;
        groupHeight += units[group]!.gap + units[group]!.height;
        groupNotes += units[group]!.noteHeight ?? 0;
      }
      if (groupHeight + groupNotes - (units[group]?.depth ?? 0) > capacity - origin) {
        groupHeight = unit.height;
        groupNotes = unit.noteHeight ?? 0;
        group = index;
      }
      const terminalDepth = units[group]?.depth ?? 0;
      let gap = cursor > origin ? unit.gap : 0;
      const overflow =
        cursor +
        gap +
        groupHeight +
        notes +
        groupNotes +
        (unit.continuationFoot ?? 0) -
        terminalDepth -
        capacity;
      if (overflow > 0.5) {
        let start = placements.length;
        while (
          start > prefix &&
          placements[start - 1]?.page === page &&
          placements[start - 1]?.column === column
        )
          start--;
        const available = placements
          .slice(start)
          .map((part, offset) =>
            Math.max(
              0,
              (units[start + offset]!.shrink ?? 0) -
                Math.max(0, units[start + offset]!.height - part.height),
            ),
          );
        const gapAvailable = placements.slice(start).map((part, offset) => {
          const source = units[start + offset]!;
          const used = part.gap ?? source.gap;
          return Math.max(
            0,
            Math.min(used, (source.gapShrink ?? 0) - Math.max(0, source.gap - used)),
          );
        });
        const currentGap = Math.min(gap, unit.gapShrink ?? 0);
        const budget = available.reduce(
          (sum, amount, index) => sum + amount + gapAvailable[index]!,
          currentGap,
        );
        if (overflow <= budget + 0.01) {
          let shift = 0;
          for (let at = start; at < placements.length; at++) {
            const part = placements[at]!;
            const amount = (overflow * available[at - start]!) / budget;
            const skip = (overflow * gapAvailable[at - start]!) / budget;
            shift += skip;
            const top = part.top - shift;
            shift += amount;
            placements[at] = {
              ...part,
              top,
              height: part.height - amount,
              gap: (part.gap ?? units[at]!.gap) - skip,
              after: { ...part.after, cursor: part.after.cursor - shift },
            };
          }
          cursor -= shift;
          gap -= (overflow * currentGap) / budget;
        }
      }
      if (
        cursor + gap + groupHeight + notes + groupNotes + (unit.continuationFoot ?? 0) >
          capacity + terminalDepth + 0.5 &&
        cursor > origin + 0.5
      )
        advance();
      if (continued) cursor += unit.continuationHead ?? 0;
      else if (cursor > origin) {
        placedGap = gap;
        cursor += gap;
      }
    }
    let height = unit.height;
    if (unit.stretch) {
      let tail = 0,
        fills = 0;
      for (
        let at = index;
        at < units.length && !units[at]!.break && units[at]!.columns === undefined;
        at++
      ) {
        tail +=
          units[at]!.height + (at === index ? 0 : units[at]!.gap) + (units[at]!.noteHeight ?? 0);
        fills += Number(Boolean(units[at]!.stretch));
      }
      height += Math.max(0, capacity - cursor - notes - tail) / Math.max(1, fills);
    }
    const top = page * stride + dimensions.top + cursor;
    cursor += height;
    notes += unit.noteHeight ?? 0;
    // A discarded page-top skip has no budget; the next page can reuse its suffix.
    elastic ||= (unit.shrink ?? 0) > 0 || (placedGap > 0 && (unit.gapShrink ?? 0) > 0);
    state = { page, column, columns, origin, cursor, notes, elastic };
    placements.push({ top, page, column, height, continued, gap: placedGap, after: state });
    visited++;
    if (visited % 128 === 0) yield;
  }
  let pages = 1;
  placements.forEach((part, index) => {
    if (units[index]!.columns !== undefined || units[index]!.break) return;
    pages = Math.max(
      pages,
      part.page +
        Math.max(
          1,
          Math.ceil(
            (part.after.cursor - (units[index]!.depth ?? 0) + dimensions.top + dimensions.bottom) /
              dimensions.height,
          ),
        ),
    );
  });
  return { dimensions, units, placements, pages, visited };
}
