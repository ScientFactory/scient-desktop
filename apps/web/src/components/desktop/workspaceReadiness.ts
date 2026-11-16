export function workspaceReadiness(input: {
  readonly initialized: boolean;
  readonly settingsHydrated: boolean;
  readonly navigating: boolean;
  readonly localEnvironment: boolean;
  readonly connected: boolean;
  readonly liveSnapshot: boolean;
}): boolean {
  return (
    input.initialized &&
    input.settingsHydrated &&
    !input.navigating &&
    input.localEnvironment &&
    input.connected &&
    input.liveSnapshot
  );
}
