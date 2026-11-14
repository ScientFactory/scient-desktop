import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { isHostedByThisApp } from "~/components/sidebar/useUpdateEverything";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { computeEnvironment } from "~/state/compute";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { environmentThreadShells } from "~/state/threads";
import { threadBlocksUpdateRestart } from "./restartWhenIdle.logic";

const busyThreadsAtom = Atom.family((environmentIds: string) => {
  const hosted = new Set(environmentIds.split("\n").filter((id) => id !== ""));
  return Atom.make((get) =>
    get(environmentThreadShells.threadShellsAtom).some(
      (thread) => hosted.has(thread.environmentId) && threadBlocksUpdateRestart(thread),
    ),
  ).pipe(Atom.withLabel(`update-restart-busy-threads:${environmentIds}`));
});

/**
 * Reads, when asked, whether this app's own threads or Compute are working. A downloaded update
 * restarts at once only when they are not; otherwise Restart waits for the user.
 */
export function useLocalWorkBlocksRestart(): () => boolean {
  const { environments } = useEnvironments();
  const hostedIds = environmentIdsKey(
    environments.filter(isHostedByThisApp).map(({ environmentId }) => environmentId),
  );
  const threadsBusy = useAtomValue(busyThreadsAtom(hostedIds));
  const localDisabled = isLocalEnvironmentDisabled();
  const primaryId = usePrimaryEnvironmentId();
  const work = useEnvironmentQuery(
    localDisabled || primaryId === null
      ? null
      : computeEnvironment.activeWork({ environmentId: primaryId, input: {} }),
  );
  // An unknown Compute count is treated as running, so a restart never stops an unseen run.
  const computeBusy = !localDisabled && (work.data?.count ?? 1) > 0;
  // Called from download and pass handlers, which see the latest committed render.
  return useStableCallback(() => threadsBusy || computeBusy);
}
