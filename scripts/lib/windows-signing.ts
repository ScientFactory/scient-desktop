// FILE: windows-signing.ts
// Purpose: Select and validate the configured Windows code-signing provider.
// Layer: Release/build helper
// Depends on: Environment variable names consumed by electron-builder and Azure Trusted Signing.

export const WINDOWS_CERTIFICATE_SIGNING_ENV_NAMES = [
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
] as const;

export const WINDOWS_AZURE_SIGNING_ENV_NAMES = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
] as const;

export type WindowsSigningProvider = "azure" | "certificate";

type WindowsSigningEnvironment = Readonly<Record<string, string | undefined>>;

function isConfigured(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function configuredCount(
  environment: WindowsSigningEnvironment,
  names: ReadonlyArray<string>,
): number {
  return names.filter((name) => isConfigured(environment[name])).length;
}

export function resolveWindowsSigningProvider(
  environment: WindowsSigningEnvironment,
): WindowsSigningProvider | null {
  const certificateConfigured = configuredCount(environment, WINDOWS_CERTIFICATE_SIGNING_ENV_NAMES);
  const azureConfigured = configuredCount(environment, WINDOWS_AZURE_SIGNING_ENV_NAMES);
  const certificateComplete =
    certificateConfigured === WINDOWS_CERTIFICATE_SIGNING_ENV_NAMES.length;
  const azureComplete = azureConfigured === WINDOWS_AZURE_SIGNING_ENV_NAMES.length;

  if (certificateComplete && azureConfigured === 0) {
    return "certificate";
  }
  if (azureComplete && certificateConfigured === 0) {
    return "azure";
  }
  if (certificateConfigured === 0 && azureConfigured === 0) {
    return null;
  }

  throw new Error(
    "Windows signing configuration is incomplete or conflicting. Configure exactly one complete provider: WIN_CSC_LINK plus WIN_CSC_KEY_PASSWORD, or all Azure Trusted Signing secrets.",
  );
}
