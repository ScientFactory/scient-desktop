import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";
import { environmentCatalog } from "../../connection/catalog";
import { environmentShell } from "../../state/shell";
import { useUiStateStore } from "../../uiStateStore";
import { getOrCreateBaseline, useAnswerBaselines } from "./baseline";
import { hasUnreadAnswer } from "./completion";

const snapshotsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  return {
    ready: catalog.isReady,
    environments: [...catalog.entries.keys()].map((environmentId) => ({
      environmentId,
      shell: get(environmentShell.stateValueAtom(environmentId)),
    })),
  };
});

/** One owner above routes, counting snapshots rather than incrementing on replayable events. */
export function ScientAnswerBadgeCoordinator() {
  const snapshots = useAtomValue(snapshotsAtom);
  const baselines = useAnswerBaselines((state) => state.byEnvironment);
  const visits = useUiStateStore((state) => state.threadLastVisitedAtById);
  useEffect(() => {
    if (!snapshots.ready) return;
    for (const { environmentId, shell } of snapshots.environments) {
      if (shell.status !== "live" || Option.isNone(shell.snapshot)) continue;
      getOrCreateBaseline(environmentId, shell.snapshot.value);
    }
  }, [snapshots]);

  const count = useMemo(() => {
    if (
      !snapshots.ready ||
      snapshots.environments.every(({ shell }) => Option.isNone(shell.snapshot))
    )
      return null;
    let unread = 0;
    for (const { environmentId, shell } of snapshots.environments) {
      if (Option.isNone(shell.snapshot)) continue;
      for (const thread of shell.snapshot.value.threads) {
        const key = scopedThreadKey(scopeThreadRef(environmentId, thread.id));
        if (!thread.archivedAt && hasUnreadAnswer(thread, visits[key] ?? baselines[environmentId]))
          unread++;
      }
    }
    return unread;
  }, [snapshots, visits, baselines]);

  useEffect(() => {
    const setBadge = window.desktopBridge?.setUnreadAnswerCount;
    if (!setBadge || count === null) return;
    const update = () => {
      void setBadge(count).catch((error: unknown) => {
        console.warn("Could not update the unread-answer badge", error);
      });
    };
    update();
    // Reapply after a user changes the OS badge permission while Scient is open.
    window.addEventListener("focus", update);
    return () => window.removeEventListener("focus", update);
  }, [count]);
  return null;
}
