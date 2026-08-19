import type { ScientOverleafAccount, ScientOverleafOperationSnapshot } from "@t3tools/contracts";

export type OverleafInitialMode = "combine" | "replace-local" | "replace-overleaf";

export function overleafProjectDashboardUrl(
  account: Pick<ScientOverleafAccount, "host" | "kind"> | null,
): string {
  if (account === null || account.kind === "cloud") return "https://www.overleaf.com/project";
  return `https://${account.host}/project`;
}

export function overleafNewProjectUrl(
  account: Pick<ScientOverleafAccount, "host" | "kind"> | null,
): string {
  return `${overleafProjectDashboardUrl(account)}/new`;
}

export function normalizeOverleafClipboardText(value: string): string {
  return value.trim();
}

export function shouldAutoCompleteOverleafPreflight(input: {
  readonly open: boolean;
  readonly mode: OverleafInitialMode;
  readonly operation: ScientOverleafOperationSnapshot | null;
}): boolean {
  const { operation } = input;
  return (
    input.open &&
    input.mode === "combine" &&
    operation?.kind === "connect" &&
    operation.connectStage === "preflight" &&
    operation.phase === "awaiting_push_confirmation" &&
    operation.review !== null &&
    operation.review.requiresConfirmation === false &&
    operation.review.warnings.length === 0
  );
}
