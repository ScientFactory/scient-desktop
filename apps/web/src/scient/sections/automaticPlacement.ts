const REVIEW_PLACEMENT_DELAY_MS = 3_000;

export interface PlacementRow {
  readonly key: string;
  readonly eligible: boolean;
  readonly orderKey: string | null;
}

export interface PlacementInput {
  readonly id: string;
  readonly rows: readonly PlacementRow[];
}

export interface PlacementGroup {
  readonly id: string;
  readonly order: readonly string[];
  readonly upper: readonly string[];
  readonly rows: readonly PlacementRow[];
}

export interface PlacementState {
  readonly groups: readonly PlacementGroup[];
  readonly pending: readonly { readonly key: string; readonly dueAt: number | null }[];
}

export const EMPTY_PLACEMENT: PlacementState = { groups: [], pending: [] };

/** Place just the moved row against canonical neighbours, preserving every other row. */
export function manualOrderForPlacement(
  canonical: readonly string[],
  displayed: readonly string[],
  moved: string,
): string[] {
  const order = canonical.filter((key) => key !== moved);
  const index = displayed.indexOf(moved);
  const before = displayed.slice(0, index).findLast((key) => order.includes(key));
  const after = displayed.slice(index + 1).find((key) => order.includes(key));
  const slot =
    before !== undefined
      ? order.indexOf(before) + 1
      : after !== undefined
        ? order.indexOf(after)
        : 0;
  order.splice(slot, 0, moved);
  return order;
}

function atBoundary(order: readonly string[], upper: ReadonlySet<string>, key: string): string[] {
  const rest = order.filter((id) => id !== key);
  const last = rest.findLastIndex((id) => upper.has(id));
  rest.splice(last + 1, 0, key);
  return rest;
}

/** Reconcile complete, synchronized membership. Filtering/collapse never enters this model. */
export function reconcilePlacement(
  state: PlacementState,
  input: readonly PlacementInput[],
  openKey: string | null,
  now: number,
): PlacementState {
  const pending = new Map(state.pending.map((entry) => [entry.key, entry.dueAt]));
  const retainedPending = new Map<string, number | null>();
  const groups = input.map(({ id, rows }): PlacementGroup => {
    const previous = state.groups.find((group) => group.id === id);
    const keys = rows.map((row) => row.key);
    const known = new Set(keys);
    if (previous === undefined) {
      const upper = rows.filter((row) => row.eligible).map((row) => row.key);
      const upperKeys = new Set(upper);
      return { id, rows, order: [...upper, ...keys.filter((key) => !upperKeys.has(key))], upper };
    }
    let order = previous.order.filter((key) => known.has(key));
    const ordered = new Set(order);
    const departures = new Set<string>();
    const upper = new Set(previous.upper.filter((key) => known.has(key)));
    const oldRows = new Map(previous.rows.map((row) => [row.key, row]));
    // New inactive rows follow their saved placement. Eligible arrivals append below retained members.
    for (const row of rows) {
      const old = oldRows.get(row.key);
      if (!ordered.has(row.key)) {
        order = manualOrderForPlacement(order, keys, row.key);
        ordered.add(row.key);
      }
      if (row.eligible) {
        if (!upper.has(row.key)) {
          order = atBoundary(order, upper, row.key);
          upper.add(row.key);
        }
      } else if (upper.has(row.key)) {
        if (row.key === openKey) retainedPending.set(row.key, null);
        else {
          const held = pending.has(row.key);
          const deadline = pending.get(row.key) ?? now + REVIEW_PLACEMENT_DELAY_MS;
          if (held && deadline > now) retainedPending.set(row.key, deadline);
          else {
            upper.delete(row.key);
            departures.add(row.key);
          }
        }
      }
      // Server-backed manual movement from another view/window is also deliberate.
      if (old !== undefined && old.orderKey !== row.orderKey) {
        order = manualOrderForPlacement(order, keys, row.key);
        retainedPending.delete(row.key);
        departures.delete(row.key);
        if (!row.eligible) upper.delete(row.key);
      }
    }
    // Prepend a simultaneous departure batch without reversing its visible order.
    for (const key of order.filter((key) => departures.has(key)).toReversed())
      order = atBoundary(order, upper, key);
    return { id, rows, order, upper: order.filter((key) => upper.has(key)) };
  });
  const next = {
    groups,
    pending: [...retainedPending].map(([key, dueAt]) => ({ key, dueAt })),
  };
  return JSON.stringify(next) === JSON.stringify(state) ? state : next;
}

/** Commit an acknowledged manual drop; pending review demotion must never undo it. */
export function manuallyPlaceThread(
  state: PlacementState,
  groupId: string,
  displayedOrder: readonly string[],
  key: string,
  currentRows: readonly PlacementInput[],
): PlacementState {
  const groups = state.groups.map((group) => {
    const rows = currentRows.find((entry) => entry.id === group.id)?.rows ?? group.rows;
    if (group.id !== groupId) {
      return {
        ...group,
        rows,
        order: group.order.filter((id) => id !== key),
        upper: group.upper.filter((id) => id !== key),
      };
    }
    const order = manualOrderForPlacement(group.order, displayedOrder, key);
    const upper = new Set(group.upper);
    if (rows.find((row) => row.key === key)?.eligible) upper.add(key);
    else upper.delete(key);
    return { ...group, rows, order, upper: order.filter((id) => upper.has(id)) };
  });
  return { groups, pending: state.pending.filter((entry) => entry.key !== key) };
}

/** Persist only positions and eligibility; timers are revalidated, never replayed after restart. */
export function readPlacement(value: unknown): PlacementState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("groups" in value) ||
    !Array.isArray(value.groups)
  )
    return EMPTY_PLACEMENT;
  const groups: PlacementGroup[] = [];
  let count = 0;
  for (const group of value.groups) {
    if (
      typeof group !== "object" ||
      group === null ||
      typeof group.id !== "string" ||
      !Array.isArray(group.rows) ||
      !Array.isArray(group.order) ||
      !Array.isArray(group.upper)
    )
      continue;
    const rows: PlacementRow[] = [];
    for (const row of group.rows) {
      if (
        typeof row !== "object" ||
        row === null ||
        typeof row.key !== "string" ||
        typeof row.eligible !== "boolean" ||
        !(row.orderKey === null || typeof row.orderKey === "string")
      )
        continue;
      if (++count > 10_000) return EMPTY_PLACEMENT;
      rows.push({ key: row.key, eligible: row.eligible, orderKey: row.orderKey });
    }
    const known = new Set(rows.map((row) => row.key));
    const order = [
      ...new Set(
        (group.order as unknown[]).filter(
          (key: unknown): key is string => typeof key === "string" && known.has(key),
        ),
      ),
    ];
    const upper = [
      ...new Set(
        (group.upper as unknown[]).filter(
          (key: unknown): key is string => typeof key === "string" && known.has(key),
        ),
      ),
    ];
    if (order.length > 0) groups.push({ id: group.id, rows, order, upper });
  }
  return { groups, pending: [] };
}
