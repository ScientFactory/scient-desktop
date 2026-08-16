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
  // The sign-in modal can switch to sign-up, which follows its own redirect
  // target; without one Clerk falls back to the URL the modal was opened from.
  return { forceRedirectUrl: href, signUpForceRedirectUrl: href };
}
