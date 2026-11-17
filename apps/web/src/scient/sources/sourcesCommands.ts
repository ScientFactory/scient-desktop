import { useAtomValue } from "@effect/atom-react";
import { type AtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createScientSourcesCommands } from "@t3tools/client-runtime/state/scient-sources-commands";
import type { EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { libraryWriteSettled } from "./libraryWrites";

/** Every Library change, each checked against the destination's grant when it runs. */
export const sourcesCommands = createScientSourcesCommands(connectionAtomRuntime);

export async function runSourcesCommand<I, A, E>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  environmentId: EnvironmentId,
  input: I,
): Promise<A> {
  const result = await command.run(appAtomRegistry, { environmentId, input });
  libraryWriteSettled(environmentId);
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

/** Whether this connection may run one Library change, from that command's own grant. */
export function useCanRunSourcesCommand(
  command: { readonly permissionAtom: (environmentId: EnvironmentId | null) => Atom.Atom<boolean> },
  environmentId: EnvironmentId | null,
): boolean {
  return useAtomValue(command.permissionAtom(environmentId));
}

/** All Library changes need the same grant, so one command's availability stands for them all. */
export function useCanChangeLibrary(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(sourcesCommands.updateMetadata.permissionAtom(environmentId));
}
