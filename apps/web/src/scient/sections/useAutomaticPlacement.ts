import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  EMPTY_PLACEMENT,
  manuallyPlaceThread,
  readPlacement,
  reconcilePlacement,
  type PlacementInput,
  type PlacementRow,
} from "./automaticPlacement";
import { useAutomaticPlacementPreference } from "./automaticPlacementPreference";

function load(key: string) {
  try {
    return readPlacement(JSON.parse(window.localStorage.getItem(key) ?? "null"));
  } catch {
    return EMPTY_PLACEMENT;
  }
}

export function useAutomaticPlacement(input: {
  readonly scope: string;
  readonly groups: readonly PlacementInput[];
  readonly openKey: string | null;
  readonly ready: boolean;
  readonly knownKeys?: readonly string[];
}) {
  const enabled = useAutomaticPlacementPreference((state) => state.enabled);
  const storageKey = `scient:sidebar:placement-order:${input.scope}`;
  const [saved, setSaved] = useState(() => ({ key: storageKey, state: load(storageKey) }));
  const [paused, setPaused] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  // Shell updates that do not change placement must not reset timers or write storage.
  const signature = JSON.stringify(input.groups);
  const groups = useMemo(() => JSON.parse(signature) as PlacementInput[], [signature]);
  const knownSignature = JSON.stringify(input.knownKeys ?? null);
  const knownKeys = useMemo(() => {
    const keys = JSON.parse(knownSignature) as string[] | null;
    return keys === null ? null : new Set(keys);
  }, [knownSignature]);
  const state = !enabled || saved.key !== storageKey ? EMPTY_PLACEMENT : saved.state;
  const writes = useRef(new Map<string, { before: string | null; after: string }>());
  const moves = useRef(
    new Map<string, { before: string | null; after: string; row: PlacementRow }>(),
  );
  const latest = useRef({ ...input, groups, state, storageKey, enabled });
  useLayoutEffect(() => {
    latest.current = { ...input, groups, state, storageKey, enabled };
  });

  // Reconcile synchronized external snapshots before paint. Transient renderer updates
  // keep the same signature, so neither this reconciliation nor persistence repeats.
  useLayoutEffect(() => {
    if (!enabled) {
      writes.current.clear();
      moves.current.clear();
      setSaved((previous) =>
        previous.key === storageKey && previous.state === EMPTY_PLACEMENT
          ? previous
          : { key: storageKey, state: EMPTY_PLACEMENT },
      );
      return;
    }
    if (paused || !input.ready) return;
    if (saved.key !== storageKey) {
      writes.current.clear();
      moves.current.clear();
    }
    if (knownKeys !== null)
      for (const key of writes.current.keys()) if (!knownKeys.has(key)) writes.current.delete(key);
    const now = Math.max(clock, Date.now());
    // Successful commands precede shell delivery. Bridge only their old value;
    // the matching echo or a newer external value releases the bridge.
    let synchronized = groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => {
        const write = writes.current.get(row.key);
        if (!write) return row;
        if (row.orderKey !== write.before) {
          writes.current.delete(row.key);
          return row;
        }
        return { ...row, orderKey: write.after };
      }),
    }));
    for (const [key, move] of moves.current) {
      const source = synchronized.find((group) => group.rows.some((row) => row.key === key));
      if (
        (knownKeys !== null && !knownKeys.has(key)) ||
        (source !== undefined && source.id !== move.before) ||
        (source === undefined && move.before !== null)
      ) {
        moves.current.delete(key);
        continue;
      }
      const row = source?.rows.find((row) => row.key === key) ?? move.row;
      synchronized = synchronized.map((group) => ({
        ...group,
        rows: [
          ...group.rows.filter((entry) => entry.key !== key),
          ...(group.id === move.after ? [row] : []),
        ],
      }));
    }
    setSaved((previous) => {
      const existing = previous.key === storageKey ? previous.state : load(storageKey);
      const next = enabled
        ? reconcilePlacement(existing, synchronized, input.openKey, now)
        : EMPTY_PLACEMENT;
      return previous.key === storageKey && previous.state === next
        ? previous
        : { key: storageKey, state: next };
    });
  }, [
    clock,
    enabled,
    groups,
    input.openKey,
    input.ready,
    knownKeys,
    saved.key,
    paused,
    storageKey,
  ]);

  useEffect(() => {
    if (!enabled || !input.ready || paused) return;
    const deadlines = state.pending.flatMap((entry) => (entry.dueAt === null ? [] : [entry.dueAt]));
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [enabled, input.ready, paused, state.pending]);

  useEffect(() => {
    if (!enabled || !input.ready || paused) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify({ groups: state.groups }));
      } catch {
        /* Placement works in memory without storage. */
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [enabled, input.ready, paused, state.groups, storageKey]);

  const onManualPlacement = useCallback(
    (
      groupId: string,
      order: readonly string[],
      key: string,
      orderKeys: ReadonlyMap<string, string>,
      movedRow?: PlacementRow,
    ) => {
      const current = latest.current;
      if (!current.enabled) return;
      for (const [id, after] of orderKeys) {
        const before = current.groups
          .flatMap((group) => group.rows)
          .find((row) => row.key === id)?.orderKey;
        if (before !== undefined && before !== after) writes.current.set(id, { before, after });
      }
      const source = current.groups.find((group) => group.rows.some((row) => row.key === key));
      const moved =
        movedRow ?? current.groups.flatMap((group) => group.rows).find((row) => row.key === key);
      if (moved && source?.id !== groupId)
        moves.current.set(key, { before: source?.id ?? null, after: groupId, row: moved });
      const inputs = current.groups.map((group) => ({
        ...group,
        rows: [
          ...group.rows.filter((row) => row.key !== key),
          ...(group.id === groupId && moved ? [moved] : []),
        ].map((row) =>
          orderKeys.has(row.key) ? { ...row, orderKey: orderKeys.get(row.key)! } : row,
        ),
      }));
      const reconciled = reconcilePlacement(current.state, inputs, current.openKey, Date.now());
      setSaved({
        key: current.storageKey,
        state: manuallyPlaceThread(reconciled, groupId, order, key, inputs),
      });
    },
    [],
  );

  return { enabled, state, onManualPlacement, onInteractionChange: setPaused };
}
