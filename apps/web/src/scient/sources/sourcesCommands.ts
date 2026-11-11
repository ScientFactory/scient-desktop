import { useAtomValue } from "@effect/atom-react";
import { type AtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createScientSourcesCommands } from "@t3tools/client-runtime/state/scient-sources-commands";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Every Library change, each checked against the destination's grant when it runs. */
export const sourcesCommands = createScientSourcesCommands(connectionAtomRuntime);

export async function runSourcesCommand<I, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  environmentId: EnvironmentId,
  input: I,
): Promise<A> {
  const result = await command.run(appAtomRegistry, { environmentId, input });
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

/** All Library changes need the same grant, so one command's availability stands for them all. */
export function useCanChangeLibrary(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(sourcesCommands.updateMetadata.permissionAtom(environmentId));
}
