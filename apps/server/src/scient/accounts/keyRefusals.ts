import type { AccountId, AccountKeyUse } from "@t3tools/contracts";

/** A use that a provider refused, for one stored version of the key. */
export interface KeyRefusal {
  readonly accountId: AccountId;
  readonly use: AccountKeyUse;
  /** The stored value it was refused for; a new value starts clean. */
  readonly version: string;
  readonly at: string;
}

const sameUse = (left: AccountKeyUse, right: AccountKeyUse) =>
  left.kind === right.kind && left.id === right.id;

/**
 * One use's outcome. A refusal is kept for that use and that version of the key; the key itself
 * counts as refused once two different uses refuse the same version. A success clears the use,
 * and the key's refused mark with it.
 */
export function withKeyUse(
  refusals: ReadonlyArray<KeyRefusal>,
  report: Omit<KeyRefusal, "at"> & { readonly at: string; readonly outcome: "refused" | "ok" },
): {
  readonly refusals: ReadonlyArray<KeyRefusal>;
  readonly key: "refused" | "works" | "unchanged";
} {
  const others = refusals.filter(
    (entry) =>
      entry.accountId !== report.accountId ||
      (entry.version === report.version && !sameUse(entry.use, report.use)),
  );
  if (report.outcome === "ok") return { refusals: others, key: "works" };
  const next = [
    ...others,
    { accountId: report.accountId, use: report.use, version: report.version, at: report.at },
  ];
  const refusing = next.filter(
    (entry) => entry.accountId === report.accountId && entry.version === report.version,
  ).length;
  return { refusals: next, key: refusing >= 2 ? "refused" : "unchanged" };
}
