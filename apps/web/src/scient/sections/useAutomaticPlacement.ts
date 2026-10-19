import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";

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

type SavedPlacement = { key: string; state: ReturnType<typeof load> };
type PlacementAction =
  | { type: "disabled"; key: string }
  | {
      type: "snapshot";
      key: string;
      groups: readonly PlacementInput[];
      openKey: string | null;
      now: number;
      isFrozen: (key: string) => boolean;
    }
  | { type: "manual"; saved: SavedPlacement };

function reduceSavedPlacement(previous: SavedPlacement, action: PlacementAction): SavedPlacement {
  if (action.type === "manual") return action.saved;
  const state =
    action.type === "disabled"
      ? EMPTY_PLACEMENT
      : reconcilePlacement(
          previous.key === action.key ? previous.state : load(action.key),
          action.groups,
          action.openKey,
          action.now,
          action.isFrozen,
        );
  return previous.key === action.key && previous.state === state
    ? previous
    : { key: action.key, state };
}

export function useAutomaticPlacement(input: {
  readonly scope: string;
  readonly groups: readonly PlacementInput[];
  readonly openKey: string | null;
  readonly ready: boolean;
  readonly knownKeys?: readonly string[];
  /** Environments without a live thread list; their rows keep their last known state. */
  readonly frozenEnvironmentIds?: readonly string[];
}) {
  const enabled = useAutomaticPlacementPreference((state) => state.enabled);
  const storageKey = `scient:sidebar:placement-order:${input.scope}`;
  const [saved, dispatchPlacement] = useReducer(reduceSavedPlacement, storageKey, (key) => ({
    key,
    state: load(key),
  }));
  const [paused, setPaused] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  // Shell updates that do not change placement must not reset timers or write storage.
  const signature = JSON.stringify(input.groups);
  const groups = JSON.parse(signature) as PlacementInput[];
  const knownSignature = JSON.stringify(input.knownKeys ?? null);
  const knownKeys = (() => {
    const keys = JSON.parse(knownSignature) as string[] | null;
    return keys === null ? null : new Set(keys);
  })();
  const frozenSignature = JSON.stringify(input.frozenEnvironmentIds ?? []);
  const isFrozen = (() => {
    const frozen = new Set(JSON.parse(frozenSignature) as string[]);
    return (key: string) =>
      frozen.size > 0 && frozen.has(parseScopedThreadKey(key)?.environmentId ?? "");
  })();
  const state = !enabled || saved.key !== storageKey ? EMPTY_PLACEMENT : saved.state;
  const writes = useRef(new Map<string, { before: string | null; after: string }>());
  const moves = useRef(
    new Map<string, { before: string | null; after: string; row: PlacementRow }>(),
  );
  const latest = useRef({ ...input, groups, state, storageKey, enabled, isFrozen });
  useLayoutEffect(() => {
    latest.current = { ...input, groups, state, storageKey, enabled, isFrozen };
  });

  // Reconcile synchronized external snapshots before paint. Transient renderer updates
  // keep the same signature, so neither this reconciliation nor persistence repeats.
  useLayoutEffect(() => {
    if (!enabled) {
      writes.current.clear();
      moves.current.clear();
      dispatchPlacement({ type: "disabled", key: storageKey });
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
    dispatchPlacement({
      type: "snapshot",
      key: storageKey,
      groups: synchronized,
      openKey: input.openKey,
      now,
      isFrozen,
    });
  }, [
    clock,
    enabled,
    groups,
    input.openKey,
    input.ready,
    isFrozen,
    knownKeys,
    saved.key,
    paused,
    storageKey,
  ]);

  useEffect(() => {
    if (!enabled || !input.ready || paused) return;
    // A frozen row's deadline waits for its environment, so it never arms the timer.
    const deadlines = state.pending.flatMap((entry) =>
      entry.dueAt === null || isFrozen(entry.key) ? [] : [entry.dueAt],
    );
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [enabled, input.ready, isFrozen, paused, state.pending]);

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

  const onManualPlacement = useStableCallback(
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
      // A frozen row is placed by its last known eligibility, not its stale copy's.
      const saved = current.isFrozen(key)
        ? current.state.groups.flatMap((group) => group.rows).find((row) => row.key === key)
        : undefined;
      const placed = moved && saved ? { ...moved, eligible: saved.eligible } : moved;
      const inputs = current.groups.map((group) => ({
        ...group,
        rows: [
          ...group.rows.filter((row) => row.key !== key),
          ...(group.id === groupId && placed ? [placed] : []),
        ].map((row) =>
          orderKeys.has(row.key) ? { ...row, orderKey: orderKeys.get(row.key)! } : row,
        ),
      }));
      // The drop alone places the moved row: reconciling without it (and before the new
      // keys) keeps it from counting as an arrival and its re-keyed neighbours as remote drops.
      const reconciled = reconcilePlacement(
        current.state,
        current.groups.map((group) => ({
          ...group,
          rows: group.rows.filter((row) => row.key !== key),
        })),
        current.openKey,
        Date.now(),
        current.isFrozen,
      );
      dispatchPlacement({
        type: "manual",
        saved: {
          key: current.storageKey,
          state: manuallyPlaceThread(reconciled, groupId, order, key, inputs, current.isFrozen),
        },
      });
    },
  );

  return { enabled, state, onManualPlacement, onInteractionChange: setPaused };
}
