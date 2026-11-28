import { T } from "gt-react";
import type { AccountId, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { m } from "~/i18n/messages";
import { msg } from "gt-react";
import { accountsState } from "./accountsState";
import { useAccountCommand } from "./useAccounts";

/**
 * The person's own Show and Copy of a saved password, the one it replaced, or an earlier one of
 * its history (`version`); each is recorded.
 */
export function PasswordReveal({
  environmentId,
  accountId,
  field,
  version,
}: {
  environmentId: EnvironmentId;
  accountId: AccountId;
  field: "password" | "previous" | "version";
  version?: string;
}) {
  const reveal = useAccountCommand(accountsState.reveal, environmentId);
  const [shown, setShown] = useState<string | null>(null);
  const read = async () => {
    const result = await reveal({ accountId, field, ...(version ? { version } : {}) });
    return result.ok ? result.value.value : null;
  };
  return (
    <span className="flex min-w-0 items-center gap-1">
      {shown !== null ? (
        <span className="truncate font-mono text-xs select-all">{shown}</span>
      ) : null}
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={async () => setShown(shown === null ? await read() : null)}
      >
        {shown === null ? <T>Show</T> : <T>Hide</T>}
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={async () => {
          // Each Copy reads and records afresh: the password may have changed since Show.
          const value = await read();
          if (value === null) return;
          await writeTextToClipboard(value);
          toastManager.add({ type: "success", title: m(msg("Copied")) });
        }}
      >
        <T>Copy</T>
      </Button>
    </span>
  );
}
