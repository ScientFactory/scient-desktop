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
  /** The active block, kept at the top. */
  readonly upper: readonly string[];
  /** Active threads dragged below inactive ones; they stay put until they go inactive. */
  readonly aside: readonly string[];
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

/**
 * Classify a dropped row: an active one within or just below the block stays in it; lower,
 * below inactive rows, it is set aside, and later arrivals no longer join beneath it.
 */
function placeDropped(
  seen: readonly string[],
  upper: Set<string>,
  aside: Set<string>,
  key: string,
  eligible: boolean,
) {
  upper.delete(key);
  aside.delete(key);
  if (!eligible) return;
  const lastUpper = seen.findLastIndex((id) => upper.has(id));
  (seen.indexOf(key) <= lastUpper + 1 ? upper : aside).add(key);
}

/**
 * Reconcile complete membership. Filtering/collapse never enters this model. Rows of an
 * environment without a live thread list (`isFrozen`) keep their last known state: they are
 * neither re-judged from a stale copy nor forgotten while missing.
 */
export function reconcilePlacement(
  state: PlacementState,
  input: readonly PlacementInput[],
  openKey: string | null,
  now: number,
  isFrozen: (key: string) => boolean = () => false,
): PlacementState {
  const pending = new Map(state.pending.map((entry) => [entry.key, entry.dueAt]));
  const retainedPending = new Map<string, number | null>();
  const listed = new Set(input.flatMap((group) => group.rows.map((row) => row.key)));
  const groups = input.map(({ id, rows: current }): PlacementGroup => {
    const previous = state.groups.find((group) => group.id === id);
    const oldRows = new Map(previous?.rows.map((row) => [row.key, row]));
    const rows = [
      ...current.map((row) => (isFrozen(row.key) ? (oldRows.get(row.key) ?? row) : row)),
      ...(previous?.rows.filter((row) => isFrozen(row.key) && !listed.has(row.key)) ?? []),
    ];
    const keys = rows.map((row) => row.key);
    const known = new Set(keys);
    if (previous === undefined || previous.rows.length === 0) {
      const upper = rows.filter((row) => row.eligible).map((row) => row.key);
      const upperKeys = new Set(upper);
      return {
        id,
        rows,
        order: [...upper, ...keys.filter((key) => !upperKeys.has(key))],
        upper,
        aside: [],
      };
    }
    let order = previous.order.filter((key) => known.has(key));
    const ordered = new Set(order);
    const departures = new Set<string>();
    const upper = new Set(previous.upper.filter((key) => known.has(key)));
    const aside = new Set(previous.aside.filter((key) => known.has(key)));
    const arrivals = new Set<string>();
    // New inactive rows follow their saved placement. Eligible arrivals append below retained members.
    for (const row of rows) {
      const old = oldRows.get(row.key);
      if (!ordered.has(row.key)) {
        order = manualOrderForPlacement(order, keys, row.key);
        ordered.add(row.key);
      }
      if (isFrozen(row.key)) {
        // No transitions; a review deadline waits until the environment is live again.
        if (pending.has(row.key)) retainedPending.set(row.key, pending.get(row.key) ?? null);
        continue;
      }
      if (row.eligible) {
        if (!upper.has(row.key) && !aside.has(row.key)) {
          order = atBoundary(order, upper, row.key);
          upper.add(row.key);
          arrivals.add(row.key);
        }
      } else if (aside.delete(row.key)) {
        // A set-aside thread that goes inactive stays where it was dropped.
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
      // Server-backed manual movement from another view/window is a drop like a local one.
      if (old !== undefined && old.orderKey !== row.orderKey) {
        order = manualOrderForPlacement(order, keys, row.key);
        retainedPending.delete(row.key);
        departures.delete(row.key);
        // Its place is the drop's, so it does not re-form the block as an arrival would.
        arrivals.delete(row.key);
        placeDropped(order, upper, aside, row.key, row.eligible);
      }
    }
    // Prepend a simultaneous departure batch without reversing its visible order.
    for (const key of order.filter((key) => departures.has(key)).toReversed())
      order = atBoundary(order, upper, key);
    // An arrival re-forms the block at the top, above inactive threads dragged there.
    if (arrivals.size > 0)
      order = [...order.filter((key) => upper.has(key)), ...order.filter((key) => !upper.has(key))];
    return {
      id,
      rows,
      order,
      upper: order.filter((key) => upper.has(key)),
      aside: order.filter((key) => aside.has(key)),
    };
  });
  // A frozen environment's whole section can be missing too; keep it as it was, minus
  // rows now listed elsewhere.
  const carried = state.groups.flatMap((group) => {
    if (
      input.some((entry) => entry.id === group.id) ||
      !group.rows.every((row) => isFrozen(row.key))
    )
      return [];
    const rows = group.rows.filter((row) => !listed.has(row.key));
    const kept = new Set(rows.map((row) => row.key));
    for (const key of kept)
      if (pending.has(key)) retainedPending.set(key, pending.get(key) ?? null);
    const keep = (keys: readonly string[]) => keys.filter((key) => kept.has(key));
    return rows.length === 0
      ? []
      : [
          {
            ...group,
            rows,
            order: keep(group.order),
            upper: keep(group.upper),
            aside: keep(group.aside),
          },
        ];
  });
  const next = {
    groups: [...groups, ...carried],
    pending: [...retainedPending].map(([key, dueAt]) => ({ key, dueAt })),
  };
  return JSON.stringify(next) === JSON.stringify(state) ? state : next;
}

/**
 * Each group's order before the layout effect reconciles: the same reconciliation, with known
 * rows' order keys held for the acknowledgement bridges, and every row held while not `live`.
 */
export function displayedPlacementOrders(
  state: PlacementState,
  input: readonly PlacementInput[],
  openKey: string | null,
  now: number,
  isFrozen: (key: string) => boolean,
  live: boolean,
): ReadonlyMap<string, readonly string[]> {
  const saved = new Map(
    state.groups.flatMap((group) => group.rows.map((row) => [row.key, row.orderKey] as const)),
  );
  const next = reconcilePlacement(
    state,
    input.map((group) => ({
      ...group,
      rows: group.rows.map((row) =>
        saved.has(row.key) ? { ...row, orderKey: saved.get(row.key)! } : row,
      ),
    })),
    openKey,
    now,
    live ? isFrozen : () => true,
  );
  return new Map(next.groups.map((group) => [group.id, group.order]));
}

/** `items` in placement order; items outside it keep their relative order at the end. */
export function sortByPlacement<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return items.toSorted(
    (left, right) => (rank.get(keyOf(left)) ?? Infinity) - (rank.get(keyOf(right)) ?? Infinity),
  );
}

/** Commit an acknowledged manual drop; pending review demotion must never undo it. */
export function manuallyPlaceThread(
  state: PlacementState,
  groupId: string,
  displayedOrder: readonly string[],
  key: string,
  currentRows: readonly PlacementInput[],
  isFrozen: (key: string) => boolean = () => false,
): PlacementState {
  const listed = new Set(currentRows.flatMap((entry) => entry.rows.map((row) => row.key)));
  const groups = state.groups.map((group) => {
    const current = currentRows.find((entry) => entry.id === group.id)?.rows;
    const saved = new Map(group.rows.map((row) => [row.key, row]));
    // Frozen rows keep the state reconciliation held, including rows it kept while missing.
    const rows =
      current === undefined
        ? group.rows
        : [
            ...current.map((row) =>
              row.key !== key && isFrozen(row.key) ? (saved.get(row.key) ?? row) : row,
            ),
            ...group.rows.filter((row) => !listed.has(row.key)),
          ];
    if (group.id !== groupId) {
      return {
        ...group,
        rows,
        order: group.order.filter((id) => id !== key),
        upper: group.upper.filter((id) => id !== key),
        aside: group.aside.filter((id) => id !== key),
      };
    }
    const order = manualOrderForPlacement(group.order, displayedOrder, key);
    const upper = new Set(group.upper);
    const aside = new Set(group.aside);
    // Judged by the rows the user saw; a filter's hidden rows must not set the drop aside.
    const placed = new Set(order);
    placeDropped(
      displayedOrder.filter((id) => placed.has(id)),
      upper,
      aside,
      key,
      rows.find((row) => row.key === key)?.eligible === true,
    );
    return {
      ...group,
      rows,
      order,
      upper: order.filter((id) => upper.has(id)),
      aside: order.filter((id) => aside.has(id)),
    };
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
    const keys = (list: unknown) => [
      ...new Set(
        (Array.isArray(list) ? (list as unknown[]) : []).filter(
          (key: unknown): key is string => typeof key === "string" && known.has(key),
        ),
      ),
    ];
    const order = keys(group.order);
    const upper = keys(group.upper);
    // Saved before set-aside existed: none.
    const aside = keys(group.aside).filter((key) => !upper.includes(key));
    if (order.length > 0) groups.push({ id: group.id, rows, order, upper, aside });
  }
  return { groups, pending: [] };
}
