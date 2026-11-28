import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { AccountsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";
import { toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
import { accountsState } from "./accountsState";

type PasswordUpdate = NonNullable<AccountsSnapshot["passwordUpdates"]>[number];

/**
 * The updates to tell the person about: each once, and none already waiting when this window
 * first read Accounts (they were told then, in the window that was open).
 */
function passwordUpdatesToTell() {
  let seen: Set<string> | undefined;
  return (updates: ReadonlyArray<PasswordUpdate>) => {
    const first = seen === undefined;
    seen ??= new Set();
    const fresh = updates.filter((update) => !seen!.has(update.undoId));
    for (const update of fresh) seen.add(update.undoId);
    return first ? [] : fresh;
  };
}

/**
 * A new password Scient saved, whether the person signed in or Scient did: "Password updated",
 * with an Undo that gives each copy of the login its own earlier password back.
 */
export function watchPasswordUpdates(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const tell = passwordUpdatesToTell();
  return registry.subscribe(
    accountsState.snapshot({ environmentId, input: {} }),
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      for (const update of tell(result.value.passwordUpdates ?? [])) {
        const id = toastManager.add({
          type: "success",
          title:
            update.field === "totp"
              ? m(msg("Two-factor saved"))
              : update.field === "recovery"
                ? m(msg("Backup codes saved"))
                : m(msg("Password updated")),
          actionProps: {
            children: m(msg("Undo")),
            onClick: () => {
              toastManager.close(id);
              void runAtomCommand(
                registry,
                accountsState.undoPassword,
                { environmentId, input: { undoId: update.undoId } },
                { reportFailure: true },
              )
                .then((undone) => {
                  // A Keychain or 1Password copy that refused keeps the newer password: say so.
                  if (undone._tag === "Success" && undone.value.mirrorsLeft?.length)
                    toastManager.add({
                      type: "warning",
                      title: m(msg("Keychain or 1Password kept the newer password")),
                    });
                })
                .catch(() => undefined);
            },
          },
        });
      }
    },
    { immediate: true },
  );
}
