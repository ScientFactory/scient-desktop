import { useAtomValue } from "@effect/atom-react";
import { AccountsError, AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import type { AtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { toastManager } from "~/components/ui/toast";
import { accountsState } from "./accountsState";

const isAccountsError = Schema.is(AccountsError);

export function useAccounts(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : accountsState.snapshot({ environmentId, input: {} }),
  );
  const scope = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const permitted = useAtomValue(accountsState.save.permissionAtom(environmentId));
  return {
    ...query,
    data: query.error ? null : query.data,
    // A refresh after each change keeps the last snapshot; writes stay enabled meanwhile.
    canWrite: scope && permitted && !query.error && query.data != null,
  };
}

export function useAccountCommand<A, E, I>(
  command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, E>,
  environmentId: EnvironmentId,
) {
  const run = useAtomCommand(command, { reportFailure: false, reportDefect: false });
  return async (input: I): Promise<{ ok: true; value: A } | { ok: false }> => {
    const result = await run({ environmentId, input });
    if (result._tag === "Success") {
      const value = result.value;
      if (
        value &&
        typeof value === "object" &&
        "warnings" in value &&
        Array.isArray(value.warnings)
      ) {
        for (const warning of value.warnings)
          if (typeof warning === "string") toastManager.add({ type: "error", title: warning });
      }
      return { ok: true, value };
    }
    // Account errors are written for the user; anything else stays generic.
    const error = Cause.squash(result.cause);
    toastManager.add({
      type: "error",
      title: isAccountsError(error) ? error.message : "Account action failed",
    });
    return { ok: false };
  };
}

export function usePasswordStorePermission(environmentId: EnvironmentId) {
  return useAtomValue(accountsState.passwordStore.permissionAtom(environmentId));
}
