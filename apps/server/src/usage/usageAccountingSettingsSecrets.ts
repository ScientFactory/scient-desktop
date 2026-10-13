import type { ServerSettings } from "@t3tools/contracts";
import type { SettingsSecret } from "../settingsSecrets.ts";

/** Accounting credentials retain their shipped store identity across settings changes. */
export function mapUsageAccountingSettingsSecrets(
  sources: ServerSettings["usageAccountingSources"],
  redactedMarker: string,
  map: (secret: SettingsSecret) => Pick<SettingsSecret, "value" | "redacted">,
): ServerSettings["usageAccountingSources"] {
  return Object.fromEntries(
    Object.entries(sources).map(([id, source]) => {
      const secret = map({
        secretName: `usage-accounting-source-${Buffer.from(id, "utf8").toString("base64url")}`,
        kind: "field",
        value: source.managementKey,
        redacted: source.managementKey === redactedMarker,
        sensitive: true,
      });
      return [id, { ...source, managementKey: secret.redacted ? redactedMarker : secret.value }];
    }),
  ) as ServerSettings["usageAccountingSources"];
}
