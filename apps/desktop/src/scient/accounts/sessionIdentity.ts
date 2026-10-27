import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import type { Session } from "electron";
import * as Schema from "effect/Schema";

const ProfileScope = Schema.fromJsonString(Schema.Tuple([Schema.String, BrowserProfileId]));
const decodeProfileScope = Schema.decodeOption(ProfileScope);
const identities = new WeakMap<
  Session,
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
    const [environmentId, profileId] = decoded.value;
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

export function accountsSessionIdentity(session: Session) {
  return identities.get(session);
}
