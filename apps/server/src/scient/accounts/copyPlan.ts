import type {
  AccountDetails,
  AccountSecretSummary,
  AccountValueSource,
  AccountWriteStore,
} from "@t3tools/contracts";

export type CopyDestination =
  | AccountValueSource
  | Extract<AccountWriteStore, { type: "1password" }>;

export function planSecretStores(
  details: AccountDetails,
  field: string,
  old: AccountSecretSummary | undefined,
  requested: ReadonlyArray<AccountWriteStore> | undefined,
  pending: ReadonlyArray<AccountWriteStore> = [],
): ReadonlyArray<CopyDestination> {
  const prior = old
    ? [old.source, ...(old.copies ?? [])].filter((source) => source.type !== "custom-model")
    : [];
  const selected: ReadonlyArray<AccountValueSource | AccountWriteStore> = [
    ...prior,
    ...(requested ?? (prior.length ? [] : [{ type: "scient" as const }])),
    ...pending,
  ];
  const site =
    "sites" in details
      ? (details.sites[0] ?? "Account")
      : details.kind === "database"
        ? details.host
        : details.tool;
  const username =
    details.kind === "website" || details.kind === "library"
      ? (details.username ?? "")
      : details.kind === "database"
        ? details.user
        : field;
  const destinations: CopyDestination[] = [];
  for (const target of selected) {
    const destination: CopyDestination =
      target.type === "keychain"
        ? {
            type: "keychain",
            service:
              "service" in target
                ? target.service
                : `Scient: ${site}${field === "password" ? "" : ` (${field})`}`,
            account: "account" in target ? target.account : username || "Sign-in",
          }
        : target;
    if (
      destination.type === "1password" &&
      "vaultId" in destination &&
      destinations.some(
        (entry) =>
          entry.type === "1password" &&
          "reference" in entry &&
          entry.reference.split("/")[2] === destination.vaultId,
      )
    )
      continue;
    if (!destinations.some((entry) => JSON.stringify(entry) === JSON.stringify(destination)))
      destinations.push(destination);
  }
  return destinations;
}
