import type { AccountsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { activityConversation } from "./activityConversation";
import { activityItemLine } from "./accountsView";
import { removedItems, useRemoveWithUndo } from "./removeWithUndo";

/** What was removed within the hour, each with the Undo its notice offered. */
export function RemovedBand({
  environmentId,
  snapshot,
  canWrite,
}: {
  environmentId: EnvironmentId;
  snapshot: Pick<AccountsSnapshot, "removed" | "changes">;
  canWrite: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const { undoRemoval } = useRemoveWithUndo(environmentId);
  const items = removedItems(snapshot.removed ?? []);
  if (items.length === 0) return null;
  return (
    <SettingsSection id="accounts-removed" title={gt("Removed")}>
      {items.map((item) => (
        <SettingsRow
          key={item.receipts[0]!.removalId}
          title={item.name}
          // An agent's removal says so, with the chat its own receipt names, beside the same Undo.
          description={
            item.threadId
              ? activityItemLine(
                  {
                    at: item.at,
                    target: { type: "account", accountId: item.receipts[0]!.accountId },
                    change: "remove",
                    threadId: item.threadId,
                  },
                  activityConversation({ threadId: item.threadId }, environmentId, messages),
                  messages,
                )
              : undefined
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite}
              onClick={() => undoRemoval(item.receipts)}
            >
              {gt("Undo")}
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
