// SCIENT-FORK:START account-deletion — whole file.
import { useClerk, useUser } from "@clerk/expo";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RelayAppleSignInRevocationRequest } from "@t3tools/contracts/relay";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Application from "expo-application";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useAtomCommand } from "../../state/use-atom-command";
import { deleteManagedRelayAccountCommand } from "./managedRelayState";

const CONFIRM_MESSAGE =
  "This deletes your Scient account and removes your linked computers from Scient Connect. This can't be undone.";
const APPLE_CONFIRM_NOTE =
  "\n\nYou signed in with Apple, so Apple asks you to confirm once. That also removes Scient from your Apple Account.";

/**
 * Apple requires that deleting an account also revokes its Sign in with Apple tokens (TN3194).
 * Clerk keeps no Apple refresh token, so this gets a fresh authorization code for the relay to
 * redeem and revoke. `cancelled` means the person dismissed Apple's sheet; `null` means revoking
 * is not possible here, and deletion goes ahead without it.
 */
async function requestAppleSignInRevocation(): Promise<
  RelayAppleSignInRevocationRequest | "cancelled" | null
> {
  const clientId = Application.applicationId;
  if (Platform.OS !== "ios" || !clientId) return null;
  try {
    if (!(await AppleAuthentication.isAvailableAsync())) return null;
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    return credential.authorizationCode
      ? { authorizationCode: credential.authorizationCode, clientId }
      : null;
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause) {
      if (cause.code === "ERR_REQUEST_CANCELED") return "cancelled";
    }
    console.warn("[scient-connect] Could not get a Sign in with Apple code for deletion", {
      cause,
    });
    return null;
  }
}

export function DeleteAccountSection(props: { readonly accountId: string | null }) {
  const clerk = useClerk();
  const { user } = useUser();
  const usesAppleSignIn =
    Platform.OS === "ios" &&
    (user?.externalAccounts.some((account) => account.provider === "apple") ?? false);
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
    const appleSignInRevocation = usesAppleSignIn ? await requestAppleSignInRevocation() : null;
    if (appleSignInRevocation === "cancelled") {
      setIsDeleting(false);
      return;
    }
    const result = await deleteAccount(
      appleSignInRevocation ? { accountId, appleSignInRevocation } : { accountId },
    );
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
      message: usesAppleSignIn ? CONFIRM_MESSAGE + APPLE_CONFIRM_NOTE : CONFIRM_MESSAGE,
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
