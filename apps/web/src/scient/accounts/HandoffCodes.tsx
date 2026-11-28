import { useGT, useMessages } from "gt-react";
import {
  ACCOUNTS_PROTOCOL_2,
  BACKUP_CODE_ID,
  type AccountHandoff,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { InputGroupAddon } from "~/components/ui/input-group";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";

/**
 * One click per code Scient found but couldn't be sure of, and one for the login's next backup
 * code, which is never used without it. The click sends an id; the server types the digits,
 * which never reach this device.
 */
export function HandoffCodeButtons({
  environmentId,
  handoff,
  canWrite,
}: {
  environmentId: EnvironmentId;
  handoff: AccountHandoff;
  canWrite: boolean;
}) {
  const insert = useAccountCommand(accountsState.insertHandoffCode, environmentId);
  const gt = useGT();
  const messages = useMessages();
  const protocol = useAccounts(environmentId).data?.accountsProtocol ?? 0;
  const codes = protocol >= ACCOUNTS_PROTOCOL_2 ? (handoff.codes ?? []) : [];
  const found = codes.map((code) => {
    // Named by its sender when the code doesn't name the service itself.
    const source = code.from ?? (code.source === "mail" ? gt("Mail") : gt("Messages"));
    return (
      <Button
        key={code.codeId}
        size="xs"
        variant={codes.length === 1 ? "default" : "outline"}
        disabled={!canWrite}
        onClick={() => void insert({ handoffId: handoff.handoffId, codeId: code.codeId })}
      >
        {codes.length === 1
          ? gt("Insert code from {source}", { source })
          : gt("Insert · {source}, {when}", {
              source,
              when: formatRelativeTimeLabel(code.at, undefined, messages),
            })}
      </Button>
    );
  });
  return handoff.backupCodes ? (
    <>
      {found}
      <Button
        size="xs"
        variant="outline"
        disabled={!canWrite}
        onClick={() => void insert({ handoffId: handoff.handoffId, codeId: BACKUP_CODE_ID })}
      >
        {gt("Use a backup code")}
      </Button>
    </>
  ) : (
    found
  );
}

/** The browser toolbar's Insert, for the sign-in waiting in this tab. */
export function BrowserCodeInsert({
  environmentId,
  tabId,
}: {
  environmentId: EnvironmentId;
  tabId: string;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  const handoff = data?.handoffs?.find(
    (entry) => entry.tabId === tabId && (entry.codes?.length || entry.backupCodes),
  );
  return handoff ? (
    <InputGroupAddon align="inline-end">
      <HandoffCodeButtons environmentId={environmentId} handoff={handoff} canWrite={canWrite} />
    </InputGroupAddon>
  ) : null;
}
