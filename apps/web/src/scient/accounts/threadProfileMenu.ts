import {
  BrowserProfileId,
  type BrowserProfile,
  type ContextMenuItem,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { resolveBrowserDefaults } from "~/browser/browserDefaults";
import { toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { accountsState } from "./accountsState";
import { accountsSnapshot } from "./openProfile";

export type BrowserProfileMenuId =
  | "browser-profile"
  | "browser-profile:inherit"
  | `browser-profile:set:${string}`;

/**
 * "Browser profile" for a conversation: the project's (or the new-tab default) first, then each
 * profile; the conversation's own choice is checked, else the first.
 */
export function browserProfileMenu(input: {
  readonly profiles: ReadonlyArray<Pick<BrowserProfile, "id" | "name">>;
  readonly defaultProfileId: string;
  readonly projectProfileId: string | undefined;
  readonly threadProfileId: string | undefined;
}): ContextMenuItem<BrowserProfileMenuId> {
  const named = (id: string | undefined) => input.profiles.find((profile) => profile.id === id);
  const project = named(input.projectProfileId);
  const inherited = project ?? named(input.defaultProfileId);
  const own = named(input.threadProfileId);
  return {
    id: "browser-profile",
    label: "Browser profile",
    icon: "globe",
    children: [
      {
        id: "browser-profile:inherit",
        label: `${project ? "Project's" : "Default"} (${inherited?.name ?? "Main"})`,
        checked: own === undefined,
      },
      ...input.profiles.map((profile, index) => ({
        id: `browser-profile:set:${profile.id}` as const,
        label: profile.name,
        checked: own?.id === profile.id,
        ...(index === 0 ? { separatorBefore: true } : {}),
      })),
    ],
  };
}

/** The submenu for a conversation, or null while Accounts can't say what it uses. */
export async function readBrowserProfileMenu(
  threadRef: ScopedThreadRef,
  projectId: ProjectId | null,
) {
  const [snapshot, defaults] = await Promise.all([
    accountsSnapshot(threadRef).catch(() => undefined),
    resolveBrowserDefaults().catch(() => undefined),
  ]);
  if (!snapshot || !defaults) return null;
  const choices = snapshot.profileChoices;
  return browserProfileMenu({
    profiles: defaults.profiles.filter((profile) => profile.kind !== "incognito"),
    defaultProfileId: defaults.profileId,
    projectProfileId: projectId === null ? undefined : choices?.projects[projectId],
    threadProfileId: choices?.threads[threadRef.threadId]?.profileId,
  });
}

export async function handleBrowserProfileMenuAction(action: string, threadRef: ScopedThreadRef) {
  if (!action.startsWith("browser-profile:")) return false;
  const chosen = action.startsWith("browser-profile:set:")
    ? BrowserProfileId.make(action.slice("browser-profile:set:".length))
    : null;
  const result = await accountsState.chooseProfile.run(appAtomRegistry, {
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, profileId: chosen },
  });
  if (result._tag !== "Success")
    toastManager.add({ type: "error", title: "Could not change the browser profile" });
  return true;
}
