import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import { providerSettingsSecretFields, SECRET_REDACTED } from "../settingsSecrets.ts";
import { readSecretFieldValues } from "../sourceControl/sourceControlHostSecrets.ts";

/** Stored credential markers cannot configure a native provider after a failed secret read. */
export function hasUnresolvedProviderCredentials(
  driver: string,
  config: unknown,
  environment: ProviderInstanceEnvironment,
): boolean {
  if (
    Predicate.isObject(config) &&
    providerSettingsSecretFields(driver).some((field) =>
      readSecretFieldValues(config[field]).some(([, value]) => value === SECRET_REDACTED),
    )
  ) {
    return true;
  }
  return environment.some(
    (variable) =>
      variable.sensitive && variable.valueRedacted === true && variable.value.length === 0,
  );
}
