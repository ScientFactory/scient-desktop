import { useAuth } from "@clerk/react";
import { useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { SCIENT_SHARE_CONTENT_ORIGIN } from "@scientfactory/scient-cloud/api";

import { useT3ConnectAuthPrompt } from "~/components/clerk/useT3ConnectAuthPrompt";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "~/cloud/publicConfig";

import { cloudApiOrigin } from "../cloudApi";
import { SharePage } from "./SharePage";
import { readShareAddress } from "./shareReader";

/**
 * `/shared/<id>#<key>` in the app: the share page with the person's Scient account, for links
 * shared with named people or only with their owner. The key stays in the fragment.
 */
export function SignedInSharePage({ shareId }: { shareId: string }) {
  // The router's hash: desktop builds use hash history, where the window's own hash is the route.
  const hash = useLocation({ select: (location) => location.hash });
  const [address] = useState(() => readShareAddress(`/s/${shareId}`, hash));
  if (!hasCloudPublicConfig()) {
    return (
      <SharePage
        address={address}
        apiOrigin={cloudApiOrigin()}
        contentOrigin={SCIENT_SHARE_CONTENT_ORIGIN}
      />
    );
  }
  return <SignedInShare address={address} />;
}

function SignedInShare({ address }: { address: ReturnType<typeof readShareAddress> }) {
  const { isSignedIn, userId, getToken } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // Wait for Clerk, so a signed-in person never sees a sign-in prompt first.
  if (isSignedIn === undefined) return null;
  return (
    <SharePage
      // Keyed by account: a share read as one person is gone once another signs in.
      key={isSignedIn ? `signed-in:${userId}` : "signed-out"}
      address={address}
      apiOrigin={cloudApiOrigin()}
      contentOrigin={SCIENT_SHARE_CONTENT_ORIGIN}
      getToken={async () =>
        isSignedIn ? ((await getToken(resolveRelayClerkTokenOptions())) ?? null) : null
      }
      onSignIn={openAuthPrompt}
    />
  );
}
