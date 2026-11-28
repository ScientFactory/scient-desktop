import type {
  AccountControls,
  AccountDetails,
  AccountSetControlsInput,
  BrowserProfileRecord,
} from "@t3tools/contracts";

/** What an agent may change on an account (AMENDMENTS 56): typed fields that widen nothing. */
export interface AccountEdit {
  readonly name?: string | undefined;
  /** A website's username. */
  readonly username?: string | undefined;
  /**
   * An API key's variable for commands: always refused. A service can choose a key by it (the
   * Library's Zotero by `ZOTERO_API_KEY`), so a new name could send the key somewhere new.
   */
  readonly envName?: string | undefined;
  /** An API key's sites, only fewer: a key is never sent anywhere new. */
  readonly sites?: ReadonlyArray<string> | undefined;
  /** A website where a new sign-in ends the other session (`oneSession`). */
  readonly oneSession?: boolean | undefined;
}

/** The account's details with the edit, or why it widens or doesn't apply. */
export function editedDetails(
  details: AccountDetails,
  edit: AccountEdit,
): { readonly details: AccountDetails } | { readonly refused: string } {
  if (edit.username !== undefined && details.kind !== "website")
    return { refused: "Only a website has a username." };
  if (edit.envName !== undefined)
    return { refused: "A key's variable is the user's to change: a service can pick a key by it." };
  if (edit.sites !== undefined && details.kind !== "api-key")
    return { refused: "Only an API key has sites to narrow." };
  if (edit.oneSession !== undefined && details.kind !== "website")
    return { refused: "Only a website keeps one session." };
  if (details.kind === "website") {
    const { oneSession: _kept, ...rest } = details;
    const oneSession = edit.oneSession ?? details.oneSession === true;
    return {
      details: {
        ...rest,
        ...(edit.username === undefined ? {} : { username: edit.username }),
        ...(oneSession ? { oneSession: true as const } : {}),
      },
    };
  }
  if (details.kind !== "api-key") return { details };
  if (edit.sites !== undefined && edit.sites.some((site) => !details.sites.includes(site)))
    return { refused: "Sites can only be removed: a key is never sent to a new site by an agent." };
  return {
    details: {
      ...details,
      ...(edit.sites === undefined ? {} : { sites: [...edit.sites] }),
    },
  };
}

/** The version an agent reads a profile at and writes back. */
export const profileVersion = (record: BrowserProfileRecord) => record.updatedAt ?? "unchanged";

const ACCESS = { off: 0, ask: 1, allowed: 2 } as const;

/** Whether an agent asks for more access than the target has: the person's Turn on card. */
export const widensAccess = (
  current: Pick<AccountControls, "access">,
  wanted: AccountSetControlsInput["access"],
) => wanted !== undefined && ACCESS[wanted] > ACCESS[current.access];

/**
 * Whether these controls only tighten what binds agents. Loosening is the person's, through the
 * Turn on card: an agent may never open Off or Ask, widen a scope or turn on reading or scripts.
 */
export function tightensOnly(
  current: AccountControls | BrowserProfileRecord,
  input: Omit<AccountSetControlsInput, "target">,
): boolean {
  if (input.access !== undefined && ACCESS[input.access] > ACCESS[current.access]) return false;
  if (input.permission !== undefined && "permission" in current)
    if (input.permission === "full" && current.permission !== "full") return false;
  if (input.visibility !== undefined && "visibility" in current)
    if (input.visibility === "readable" && current.visibility !== "readable") return false;
  if (input.scriptSignIn === true && !("scriptSignIn" in current && current.scriptSignIn === true))
    return false;
  if (input.scope !== undefined) {
    if (input.scope.type === "all-projects") return current.scope.type === "all-projects";
    if (current.scope.type === "projects") {
      const allowed = new Set(current.scope.projectIds);
      if (input.scope.projectIds.some((projectId) => !allowed.has(projectId))) return false;
    }
  }
  return true;
}
