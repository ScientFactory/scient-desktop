import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import type { MarkdownPersistenceLease } from "./markdownPersistenceRegistry";

/**
 * Plain-Markdown save policy surface. The retained lease owns every keystroke;
 * the editor's displayed source is the lease's draft projection, and a stale
 * projection is rejected instead of silently overwriting a newer edit version.
 * The inherited file panel only composes these bindings with its editor.
 */
export function useMarkdownSourcePersistence(persistence: MarkdownPersistenceLease) {
  const snapshot = useSyncExternalStore(persistence.subscribe, persistence.getSnapshot);
  const appliedVersion = useRef(snapshot.editVersion);
  const active = useRef(false);
  const [, rejectStaleProjection] = useState(0);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const onProjectionApplied = useCallback(
    (source: string) => {
      const current = persistence.getSnapshot();
      if (active.current && source === current.draftSource)
        appliedVersion.current = current.editVersion;
    },
    [persistence],
  );
  const onContentsChange = useCallback(
    (source: string) => {
      if (!active.current) return;
      if (!persistence.change(source, appliedVersion.current)) {
        rejectStaleProjection((version) => version + 1);
      } else appliedVersion.current = persistence.getSnapshot().editVersion;
    },
    [persistence],
  );
  const onExternalVersionApplied = useCallback((version: number) => {
    appliedVersion.current = version;
  }, []);
  return {
    contents: snapshot.draftSource,
    revision: snapshot.baselineRevision,
    onContentsChange,
    onProjectionApplied,
    externalPersistence: persistence,
    onExternalVersionApplied,
    editingBlocked: snapshot.editingBlocked,
  };
}
