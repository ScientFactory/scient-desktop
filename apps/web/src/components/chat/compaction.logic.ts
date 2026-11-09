import { COMPACT_COMMAND_PATTERN } from "@t3tools/client-runtime/state/context-window";
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";

function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

export function formatContextWindowCompactionMessage(autoCompactThreshold?: number | null): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at about ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  return "Context compacts automatically when needed.";
}

// SCIENT-FORK:START — resume compaction before an ordinary send.
/** Compact only ordinary server sends; queue edits/retries keep their captured payload. */
export function shouldCompactBeforeSend(input: {
  readonly ordinaryServerSend: boolean;
  readonly hasCapturedQueueSubmission: boolean;
  readonly multipleModels: boolean;
  readonly resumeCompactionTokens: number | null;
  readonly keepFullHistory: boolean;
  readonly messageText: string;
}): boolean {
  return (
    input.ordinaryServerSend &&
    !input.hasCapturedQueueSubmission &&
    !input.multipleModels &&
    input.resumeCompactionTokens !== null &&
    !input.keepFullHistory &&
    !COMPACT_COMMAND_PATTERN.test(input.messageText.trim())
  );
}
// SCIENT-FORK:END
