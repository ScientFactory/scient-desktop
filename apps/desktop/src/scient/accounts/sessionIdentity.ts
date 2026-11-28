import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import type { Session } from "electron";
import * as Schema from "effect/Schema";

// A profile's later generations add theirs (round 6b): the same profile, another partition.
const ProfileScope = Schema.fromJsonString(
  Schema.Union([
    Schema.Tuple([Schema.String, BrowserProfileId]),
    Schema.Tuple([Schema.String, BrowserProfileId, Schema.Int]),
  ]),
);
const decodeProfileScope = Schema.decodeOption(ProfileScope);
const identities = new WeakMap<
  object,
  { environmentId: string; profileId: string; persistent: boolean }
>();

export function rememberAccountsSession(
  session: Session,
  scope = "shared",
  persistent = true,
  namespace?: "profile",
) {
  if (namespace === "profile") {
    const decoded = decodeProfileScope(scope);
    if (decoded._tag === "None") return;
    const [environmentId, profileId] = decoded.value as readonly [string, string];
    identities.set(session, {
      environmentId,
      profileId,
      persistent: persistent && profileId !== INCOGNITO_BROWSER_PROFILE_ID,
    });
  } else {
    identities.set(session, {
      environmentId: scope,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
      persistent,
    });
  }
}

export function accountsSessionIdentity(session: object) {
  return identities.get(session);
}
