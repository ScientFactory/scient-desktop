export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  if (isElectron) {
    // Electron routes through the hash. Normalize Clerk's virtual callback path and
    // query while retaining Scient's current route and custom protocol.
    const redirectUrl = new URL(href);
    redirectUrl.pathname = "/";
    redirectUrl.search = "";

    return {
      forceRedirectUrl: redirectUrl.toString(),
      signUpForceRedirectUrl: redirectUrl.toString(),
    };
  }
  // Set sign-up's redirect too; switching from sign-in otherwise falls back to the modal's opening URL.
  return { forceRedirectUrl: href, signUpForceRedirectUrl: href };
}
