import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

/**
 * Turn start records the workspace a native thread is bound to. Adapters do not own that binding
 * and re-emit cached copies of the row, possibly from before a relocation, so while the same
 * session owns the thread the recorded value wins over whatever the adapter carries.
 */
export const withRecordedWorkspace = (
  recorded: OrchestrationV2ProviderThread | undefined,
  update: OrchestrationV2ProviderThread,
): OrchestrationV2ProviderThread => {
  if (recorded?.id !== update.id || recorded.providerSessionId !== update.providerSessionId)
    return update;
  const cwd = recorded.nativeMetadata?.cwd;
  if (cwd === update.nativeMetadata?.cwd) return update;
  const { cwd: _adapterCwd, ...nativeMetadata } = update.nativeMetadata ?? {};
  return {
    ...update,
    nativeMetadata: cwd === undefined ? nativeMetadata : { ...nativeMetadata, cwd },
  };
};
