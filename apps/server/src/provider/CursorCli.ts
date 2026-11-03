const SCIENT_MANAGED_CURSOR_RUNTIME = "SCIENT_MANAGED_CURSOR_RUNTIME";

export function cursorRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  usesManagedRuntime: boolean,
): NodeJS.ProcessEnv {
  if (usesManagedRuntime) return { ...environment, [SCIENT_MANAGED_CURSOR_RUNTIME]: "1" };
  if (!(SCIENT_MANAGED_CURSOR_RUNTIME in environment)) return environment;
  const { [SCIENT_MANAGED_CURSOR_RUNTIME]: _ignored, ...externalEnvironment } = environment;
  return externalEnvironment;
}
