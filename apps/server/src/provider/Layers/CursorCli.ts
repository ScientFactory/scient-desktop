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

export function cursorCliArgs(
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  return environment?.[SCIENT_MANAGED_CURSOR_RUNTIME] === "1"
    ? ["--disable-auto-update", ...args]
    : args;
}

export function hasExternalCursorAccountConfiguration(
  settings: { readonly apiEndpoint?: string | null | undefined },
  environment: NodeJS.ProcessEnv,
): boolean {
  if (settings.apiEndpoint?.trim()) return true;
  return Object.entries(environment).some(([name, value]) => {
    const normalized = name.toUpperCase();
    return (
      typeof value === "string" &&
      value.trim() !== "" &&
      (normalized === "CURSOR_API_KEY" || normalized === "CURSOR_AUTH_TOKEN")
    );
  });
}
