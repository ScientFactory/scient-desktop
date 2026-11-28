import type { AccountsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { useEffect, useState } from "react";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { activityConversation } from "./activityConversation";
import { accountsState } from "./accountsState";
import { operationOutcome, operationTitle, settled, undoAndTell } from "./profileOperations";
import { useAccountCommand } from "./useAccounts";

type Operation = NonNullable<AccountsSnapshot["profileOperations"]>[number];

/**
 * Each one in its hour, ended and not undone: the person's or an agent's, with its Undo. A
 * refresh or import has none; its Activity line is the record (round 6m).
 */
function undoableOperations(operations: ReadonlyArray<Operation>, now: number) {
  return operations
    .filter(
      (operation) =>
        operation.kind !== "refresh" &&
        Date.parse(operation.until) > now &&
        !operation.undone &&
        settled(operation),
    )
    .toReversed();
}

/**
 * A profile's changes within the hour, each with the Undo its notice offered (round 6c): the
 * notice goes after a while, the hour of Undo doesn't. An agent's says which chat made it.
 */
export function ProfileChangesBand({
  environmentId,
  snapshot,
  canWrite,
}: {
  environmentId: EnvironmentId;
  snapshot: Pick<AccountsSnapshot, "profileOperations" | "profiles">;
  canWrite: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const undo = useAccountCommand(accountsState.undoProfile, environmentId);
  // A minute's tick is enough for rows to leave as their hour ends.
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a minute's timer, held while mounted, so a row leaves when its hour ends
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const items = undoableOperations(snapshot.profileOperations ?? [], now);
  if (items.length === 0) return null;
  const nameOf = (profileId: string | undefined, fallback?: string) =>
    snapshot.profiles.find((record) => record.profileId === profileId)?.name ??
    fallback ??
    profileId ??
    "";
  return (
    <SettingsSection id="accounts-profile-changes" title={gt("Recent changes")}>
      {items.map((operation) => {
        const outcome = operationOutcome(operation, messages);
        const chat = operation.threadId
          ? activityConversation({ threadId: operation.threadId }, environmentId, messages)
          : undefined;
        const description = [chat, outcome.description].filter(Boolean).join(" · ");
        return (
          <SettingsRow
            key={operation.operationId}
            title={operationTitle(
              operation,
              {
                name: nameOf(operation.profileId, operation.name),
                into: nameOf(operation.into),
              },
              messages,
            )}
            {...(description ? { description } : {})}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite}
                onClick={() => void undoAndTell(undo, operation.operationId)}
              >
                {gt("Undo")}
              </Button>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
