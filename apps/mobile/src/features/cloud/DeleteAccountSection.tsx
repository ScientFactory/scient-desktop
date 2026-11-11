// SCIENT-FORK:START account-deletion — whole file.
import { useClerk } from "@clerk/expo";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../state/use-atom-command";
import { deleteManagedRelayAccountCommand } from "./managedRelayState";

const CONFIRM_MESSAGE =
  "This deletes your Scient account and removes your linked computers from Scient Connect. This can't be undone.";

export function DeleteAccountSection(props: { readonly accountId: string | null }) {
  const clerk = useClerk();
  const deleteAccount = useAtomCommand(deleteManagedRelayAccountCommand, { reportFailure: false });
  const [isDeleting, setIsDeleting] = useState(false);

  // The Clerk user is gone; signing out only clears this device's session.
  const signOutDeletedAccount = async () => {
    try {
      await clerk.signOut();
    } catch (cause) {
      console.warn("[scient-connect] Sign-out after account deletion failed", { cause });
      Dialog.alert(
        "Account deleted",
        "Your account was deleted, but this phone is still signed in.",
        [{ text: "Sign out", onPress: () => void signOutDeletedAccount() }],
      );
    }
  };

  const handleDelete = async (accountId: string) => {
    setIsDeleting(true);
    const result = await deleteAccount({ accountId });
    if (result._tag === "Success") {
      await signOutDeletedAccount();
      return;
    }
    setIsDeleting(false);
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not delete your account.";
    const traceId = findErrorTraceId(cause);
    console.error("[scient-connect] Could not delete account", { message, traceId, cause });
    Dialog.alert(
      "Could not delete account",
      traceId ? `${message}\n\nTrace ID: ${traceId}` : message,
      traceId
        ? [
            {
              text: "Copy trace ID",
              onPress: () => copyTextWithHaptic(traceId, { target: "connection-trace-id" }),
            },
            { text: "OK", style: "cancel" },
          ]
        : undefined,
    );
  };

  const accountId = props.accountId;
  const confirmDelete = () => {
    if (!accountId || isDeleting) return;
    Dialog.confirm({
      title: "Delete account?",
      message: CONFIRM_MESSAGE,
      confirmText: "Delete account",
      destructive: true,
      onConfirm: () => void handleDelete(accountId),
    });
  };

  return (
    <View collapsable={false} className="pt-8">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !accountId || isDeleting, busy: isDeleting }}
        disabled={!accountId || isDeleting}
        onPress={confirmDelete}
        className="flex-row items-center gap-3 border-y border-clerk-border px-6 py-4 active:opacity-60 disabled:opacity-50"
      >
        <Text className="min-w-0 flex-1 text-base font-semibold text-clerk-danger">
          {isDeleting ? "Deleting account" : "Delete account"}
        </Text>
        {isDeleting ? (
          <AppActivityIndicator colorClassName={"accent-clerk-foreground-muted"} size="small" />
        ) : null}
      </Pressable>
      <Text className="px-6 pt-3 text-xs leading-normal text-clerk-foreground-muted">
        Deletes your Scient account and removes your linked computers from Scient Connect.
      </Text>
    </View>
  );
}
// SCIENT-FORK:END account-deletion
