import { useAuth } from "@clerk/react";

import { useT3ConnectAuthPrompt } from "~/components/clerk/useT3ConnectAuthPrompt";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "~/cloud/publicConfig";

import { cloudApi } from "./cloudApi";

/**
 * A test account for local end-to-end runs against `infra/scient-cloud`'s dev server, which
 * accepts `dev:<userId>` tokens. Production builds compile it to null; the deployed Worker
 * refuses those tokens anyway.
 */
const devCloudUserId: string | null = import.meta.env.DEV
  ? (import.meta.env.VITE_SCIENT_CLOUD_DEV_USER as string | undefined)?.trim() || null
  : null;

/** Whether the app can reach a Scient account for Scient Cloud. */
export function hasCloudAccount(): boolean {
  return devCloudUserId !== null || hasCloudPublicConfig();
}

/**
 * The signed-in person's Scient account, for talking to Scient Cloud. Only call it where
 * `hasCloudAccount()` holds, because that is when the app mounts Clerk.
 */
function useClerkCloudAccount() {
  const { isSignedIn, userId, getToken } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const api = cloudApi(async () => (await getToken(resolveRelayClerkTokenOptions())) ?? null);
  return {
    /** Undefined until Clerk has loaded. */
    isSignedIn,
    userId: userId ?? null,
    api,
    openSignIn: openAuthPrompt,
  };
}

type CloudAccount = ReturnType<typeof useClerkCloudAccount>;

const devCloudAccount: CloudAccount | null =
  devCloudUserId === null
    ? null
    : {
        isSignedIn: true,
        userId: devCloudUserId,
        api: cloudApi(async () => `dev:${devCloudUserId}`),
        openSignIn: () => {},
      };

export const useCloudAccount: () => CloudAccount =
  devCloudAccount === null ? useClerkCloudAccount : () => devCloudAccount;
