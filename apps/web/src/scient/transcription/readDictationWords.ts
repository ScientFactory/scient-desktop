import { createEnvironmentRpcCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type DictationVocabulary,
} from "@t3tools/contracts";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:read-words",
  tag: WS_METHODS.voiceReadWords,
  concurrency: { mode: "parallel" },
});

export async function readDictationWords(
  environmentId: EnvironmentId,
  projectId: ProjectId | null | undefined,
  language: string,
  signal?: AbortSignal,
): Promise<DictationVocabulary> {
  const deadline = AbortSignal.timeout(2_000);
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    {
      environmentId,
      input: { ...(projectId ? { projectId } : {}), language },
    },
    { reportFailure: false, signal: signal ? AbortSignal.any([signal, deadline]) : deadline },
  );
  return result._tag === "Success" ? result.value : { words: [], hints: [] };
}
