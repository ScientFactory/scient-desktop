import { useAuth } from "@clerk/react";

import { useT3ConnectAuthPrompt } from "~/components/clerk/useT3ConnectAuthPrompt";
import { resolveRelayClerkTokenOptions } from "~/cloud/publicConfig";

import { cloudApi } from "./cloudApi";

/**
 * The signed-in person's Scient account, for talking to Scient Cloud. Only call it where
 * `hasCloudPublicConfig()` holds, because that is when the app mounts Clerk.
 */
export function useCloudAccount() {
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
