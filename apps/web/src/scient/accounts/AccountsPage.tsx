import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import {
  ACCOUNTS_PROTOCOL_1,
  ACCOUNTS_PROTOCOL_2,
  AuthOrchestrationReadScope,
  DEFAULT_BROWSER_PROFILE_ID,
  GOOGLE_SITE,
  AccountId,
  PROVIDER_DISPLAY_NAMES,
  resolveBrowserProfiles,
  type AccountCodeSources,
  type AccountPlainKey,
  type AccountSummary,
  type AccountsSnapshot,
  type ConnectorId,
  type ConnectorSummary,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  EllipsisIcon,
  KeyRoundIcon,
  LinkIcon,
  MessageSquareIcon,
  PlusIcon,
} from "lucide-react";
import { Fragment, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { ExtensionIcon } from "~/scient/extensions/ExtensionRow";
import { extensionsInventory } from "~/scient/extensions/extensionsState";
import { useProviderInventory } from "~/scient/extensions/useProviderInventory";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { sameHostEnvironmentIdsAtom } from "~/scient/sameHost";
import { useEnvironmentQuery } from "~/state/query";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "~/state/server";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { orderSavedLogins, possibleDuplicates, savedLogins, type SavedLogin } from "./savedLogins";
import { loginSiteKey } from "@t3tools/shared/scientLoginIdentity";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import { signInStopped } from "@t3tools/shared/scientAccountSignIn";
import { universityDetails } from "@t3tools/shared/scientPaperLinks";
import { siteIdentities } from "@t3tools/shared/scientBrowserProfileChoice";
import "./accounts.css";
import { NeedsYouBand } from "./NeedsYouBand";
import { RemovedBand } from "./RemovedBand";
import { ProfileChangesBand } from "./ProfileChangesBand";
import { activityConversation } from "./activityConversation";
import { ApiKeyAccountPicker, keyOptions } from "./ApiKeyAccountPicker";
import { variableKeyFits } from "./VariableAccountKey";
import type { AccountsLink } from "./accountsLink";
import { useOverleafTokenSaved } from "../overleaf/overleafStore";
import { useChatGptDictation } from "../voice/chatGptDictation";
import { keyUseLabel } from "./keyUses";
import { AccessChip, ControlsMenu, ScopeSubmenu } from "./AccountControls";
import { SavedLoginDetails } from "./SavedLoginDetails";
import { AccountDialog } from "./AccountDialog";
import { AccountLogo, SiteFavicon } from "./AccountLogo";
import { accountsState } from "./accountsState";
import { useAccountsExternalIdentities } from "./useAccountsExternalIdentities";
import {
  KIND_LABELS,
  accountIconUrl,
  accountManagePage,
  accountStatusLabel,
  signInInterrupted,
  activityItemLine,
  activityWithChanges,
  type ActivityItem,
  type ApiKeyRow,
  apiKeyRows,
  type GitHubIdentity,
  githubIdentities,
  signedOutAgents,
  isBrowserSignIn,
  isSavedPassword,
  mergeProfiles,
  onlyIn,
  type ProviderRowsCache,
  steadyProviderRows,
  signedIntoUniversity,
} from "./accountsView";
import { UniversityIcon, UniversityRowMenu, useRemoveUniversity } from "./University";
import { groupOf } from "@t3tools/shared/scientUniversityGroups";
import { shownUniversities } from "./universityView";
import { AccountStoreMenuItems } from "./AccountStoreMenuItems";
import { AccountsStatusLine } from "./AccountsStatusLine";
import {
  BrowserImportDialog,
  BrowserProfiles,
  GOOGLE_SIGNED_OUT,
  useImportingPasswords,
} from "./BrowserProfiles";
import { copySignInIntoMain } from "./mainFill";
import { CHROME_WINDOW_ACTION, useChromeSignIn } from "./ChromeSignIn";
import { RemoteComputers } from "./RemoteComputers";
import { clickableAccountRow } from "./clickableAccountRow";
import { OnePasswordDialog, PasswordFileInput, PasswordStores } from "./PasswordStores";
import { useAccountBrowser } from "./useAccountBrowser";
import { wantPasswordFix } from "./newPasswords";
import { passwordFindingLabel } from "@t3tools/shared/scientSignInPage";
import { useRemoveWithUndo } from "./removeWithUndo";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { useSignIn } from "./useSignIn";
import { useWebsiteSessions } from "./useWebsiteSessions";
import { m } from "~/i18n/messages";

/** Provider rows last read per environment, so a refresh doesn't empty "Apps and connectors". */
const providerRowsCache: ProviderRowsCache = new Map();

/** Where each kind of sign-in is managed, for the "Apps and connectors" links. */
const MANAGED_IN = {
  claude: "Claude",
  codex: "Codex",
  droid: "Droid",
  extension: "Extensions",
  scient: "Scient Agent",
  overleaf: "Overleaf",
  chatgpt: "Voice",
} as const;

export function AccountRow({
  account,
  environmentId,
  canWrite,
  onEdit,
  onActivity,
  aside,
  menu,
  detail,
  onRemove,
  uses,
  login,
  onOpen,
  expanded,
}: {
  account: AccountSummary;
  /** A row click opens this instead of the editor, such as details in place. */
  onOpen?: () => void;
  /** With `onOpen`: whether what it opens is showing. */
  expanded?: boolean;
  /** Opens a confirmation instead of removing at once. */
  onRemove?: () => void;
  /** Named in the Undo toast. */
  uses?: ReadonlyArray<string>;
  /** The login this row stands for in Saved passwords; access applies to every copy. */
  login?: SavedLogin;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onEdit: () => void;
  onActivity: (entries: ReadonlyArray<ActivityItem>) => void;
  /** The line under the name, in place of what the account's kind says. */
  detail?: ReactNode;
  /** Beside the access chip, such as which profile Main uses for the site. */
  aside?: ReactNode;
  /** More items for the row's menu. */
  menu?: ReactNode;
}) {
  const openBrowser = useAccountBrowser(environmentId);
  const profiles = resolveBrowserProfiles(
    useClientSettings((settings) => settings.browserProfiles),
  );
  const newTabProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const controls = useAccountCommand(accountsState.setControls, environmentId);
  const test = useAccountCommand(accountsState.test, environmentId);
  const { removeAccount } = useRemoveWithUndo(environmentId);
  const activity = useAccountCommand(accountsState.activity, environmentId);
  const save = useAccountCommand(accountsState.save, environmentId);
  const [busy, setBusy] = useState(false);
  const gt = useGT();
  const messages = useMessages();
  const target = { type: "account", accountId: account.accountId } as const;
  const details = account.details;
  // A key kept for one use has that use's reach, not agent controls.
  const keptFor = details.kind === "api-key" ? details.privateTo : undefined;
  const site = details.kind === "website" ? details.sites[0] : undefined;
  const check = useAccountCommand(accountsState.check, environmentId);
  const snapshot = useAccounts(environmentId).data;
  const interrupted = snapshot ? signInInterrupted(account, snapshot) : false;
  const statusLabel = accountStatusLabel(
    account,
    (iso) => formatRelativeTimeLabel(iso, undefined, messages),
    messages,
    interrupted,
  );
  const university = universityDetails(details);
  const signIn = useSignIn(environmentId);
  const signInAnyRow = (snapshot?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_1;
  const neverAsk = useAccountCommand(accountsState.neverAsk, environmentId);
  // "Don't ask for this site" was chosen for this login's site: one press asks again.
  const notAsked = (snapshot?.neverAsk ?? []).find(
    (origin) =>
      details.kind === "website" && details.sites.some((own) => loginSiteKey(own) === origin),
  );
  const held = signInStopped(account.signIn) || interrupted;
  const signInAgain = held || account.signIn?.state === "signed-out";
  const openSite = async () => {
    if (!site) return;
    await openBrowser(site, details.kind === "website" ? details.profileId : undefined);
  };
  const finding = snapshot?.passwordHealth?.find(
    (entry) => entry.accountId === account.accountId,
  )?.finding;
  // Fix fills the change page itself, which needs this desktop's own browser tabs, and a server
  // that holds the new password from before its fill (`reserve`).
  const canFix =
    window.desktopBridge?.accounts?.originBoundFill === true &&
    snapshot?.pendingFeatures?.includes("reserve") === true;
  /**
   * The site's change-password page; the new password fills itself there, in the tab Fix opened,
   * saved with Undo. A site without the well-known page gets its own password page looked for.
   */
  const fixPassword = async () => {
    if (!site) return;
    const page = new URL(
      "/.well-known/change-password",
      site.includes("://") ? site : `https://${site}`,
    );
    await openBrowser(
      page.href,
      details.kind === "website" ? details.profileId : undefined,
      undefined,
      (opened) =>
        wantPasswordFix(account, { environmentId, ...opened, origin: page.origin }, Date.now()),
    );
  };
  const iconUrl = accountIconUrl("sites" in details ? details.sites : [], account.name);
  const managePage = accountManagePage("sites" in details ? details.sites : []);
  return (
    <SettingsRow
      {...clickableAccountRow(onOpen ?? onEdit)}
      {...(onOpen ? { "aria-expanded": expanded ?? false } : {})}
      aria-label={
        onOpen
          ? gt("Details for {name}", { name: account.name })
          : gt("Edit {name}", { name: account.name })
      }
      title={
        <span className="flex min-w-0 items-center gap-3">
          {iconUrl ? (
            <AccountLogo src={iconUrl} className="size-10 self-center rounded-[25%]" />
          ) : university ? (
            <UniversityIcon site={site ?? ""} className="size-10" />
          ) : site ? (
            <SiteFavicon site={site} />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted">
              <KeyRoundIcon className="size-4 text-muted-foreground" />
            </span>
          )}
          <span className="grid min-w-0 gap-1">
            <span className="truncate text-left">{account.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {detail ??
                (details.kind === "website" && (university || !account.secrets.password)
                  ? [
                      university
                        ? (university.institution?.domain ?? details.username ?? details.sites[0])
                        : (details.username ?? gt("Browser sign-in")),
                      profiles.find(
                        (profile) =>
                          profile.id ===
                          (details.profileId ?? newTabProfileId ?? DEFAULT_BROWSER_PROFILE_ID),
                      )?.name,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : isSavedPassword(account) && details.kind === "website"
                    ? // The username tells two sign-ins to the same site apart.
                      [
                        details.username,
                        account.name === site ? undefined : details.sites.join(", "),
                      ]
                        .filter(Boolean)
                        .join(" · ") || messages(KIND_LABELS.website)
                    : [
                        keptFor
                          ? gt("Only for {use}", { use: keptFor.name })
                          : messages(KIND_LABELS[details.kind]),
                        "sites" in details
                          ? details.sites.join(", ")
                          : details.kind === "database"
                            ? details.host
                            : details.tool,
                      ]
                        .filter(Boolean)
                        .join(" · "))}
            </span>
          </span>
          {statusLabel ? (
            <Tooltip>
              <TooltipTrigger render={<span className="shrink-0 text-xs text-muted-foreground" />}>
                {statusLabel}
              </TooltipTrigger>
              {account.signIn?.detail ? <TooltipPopup>{account.signIn.detail}</TooltipPopup> : null}
            </Tooltip>
          ) : null}
          {finding ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {passwordFindingLabel(finding, messages)}
            </span>
          ) : null}
          {account.status === "needs-attention" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={gt("Needs attention")}
                    className="size-1.5 shrink-0 self-center rounded-full bg-amber-500"
                  />
                }
              />
              <TooltipPopup>{account.statusMessage ?? gt("Needs attention")}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      }
      control={
        <div className="flex items-center gap-2">
          {(university && !signedIntoUniversity(account)) ||
          (!university && held && signInAnyRow && details.kind === "website") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite}
              onClick={(event) => {
                event.stopPropagation();
                void signIn(account.accountId);
              }}
            >
              <T>Sign in</T>
            </Button>
          ) : null}
          {finding && site && canFix ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite}
              onClick={(event) => {
                event.stopPropagation();
                void fixPassword();
              }}
            >
              <T>Fix</T>
            </Button>
          ) : null}
          {aside}
          {!keptFor ? (
            <AccessChip
              environmentId={environmentId}
              target={target}
              access={login?.access ?? account.controls.access}
              disabled={!canWrite || busy}
              {...(login
                ? {
                    copies: login.copies.map(
                      (copy) => ({ type: "account", accountId: copy.accountId }) as const,
                    ),
                  }
                : {})}
            />
          ) : null}
          <ControlsMenu disabled={!canWrite || busy}>
            {university ? (
              <MenuItem onClick={() => void signIn(account.accountId)}>
                <T>Sign in</T>
              </MenuItem>
            ) : signInAgain && details.kind === "website" ? (
              signInAnyRow ? (
                <MenuItem onClick={() => void signIn(account.accountId)}>
                  <T>Sign in again</T>
                </MenuItem>
              ) : (
                <MenuItem disabled>
                  <T>Update Scient on this computer to sign in from here</T>
                </MenuItem>
              )
            ) : null}
            <MenuItem
              onClick={async () => {
                setBusy(true);
                // A website is looked at on its site; any other account checks its saved value.
                if (details.kind === "website") {
                  window.dispatchEvent(new Event("scient-accounts-session-changed"));
                  await check({ accountId: account.accountId });
                } else {
                  const result = await test({ accountId: account.accountId });
                  // "Works" only once its service accepted it; a value that only reads says so.
                  if (result.ok)
                    toastManager.add(
                      result.value.result === "works"
                        ? { type: "success", title: m(msg("Works")) }
                        : result.value.result === "refused"
                          ? { type: "error", title: m(msg("Key refused")) }
                          : { type: "info", title: m(msg("Value readable")) },
                    );
                }
                setBusy(false);
              }}
            >
              <T>Check</T>
            </MenuItem>
            {notAsked ? (
              <MenuItem onClick={() => void neverAsk({ remove: notAsked })}>
                <T>Offer to save again</T>
              </MenuItem>
            ) : null}
            {site && !university ? (
              <MenuItem onClick={() => void openSite()}>
                <T>
                  Open <Var>{site}</Var>
                </T>
              </MenuItem>
            ) : null}
            {menu}
            <AccountStoreMenuItems account={account} />
            <MenuItem onClick={onEdit}>
              <T>Edit</T>
            </MenuItem>
            {details.kind === "website" && !university ? (
              <MenuCheckboxItem
                variant="switch"
                checked={details.oneSession === true}
                onCheckedChange={(one) => {
                  const { oneSession: _previous, ...rest } = details;
                  void save({
                    accountId: account.accountId,
                    name: account.name,
                    details: one ? { ...rest, oneSession: true } : rest,
                    secrets: {},
                  });
                }}
              >
                <T>Sign in only when I ask</T>
              </MenuCheckboxItem>
            ) : null}
            <MenuItem
              onClick={async () => {
                const result = await activity({ target });
                // What agents changed on it is listed with its uses.
                if (result.ok)
                  onActivity(activityWithChanges(result.value, snapshot?.changes, target));
              }}
            >
              <T>Activity</T>
            </MenuItem>
            {managePage ? (
              <MenuItem
                onClick={() =>
                  void readLocalApi()
                    ?.shell.openExternal(managePage.url)
                    .catch(() => undefined)
                }
              >
                <T>
                  Manage on <Var>{managePage.domain}</Var>
                </T>
              </MenuItem>
            ) : null}
            {!keptFor ? (
              <>
                <MenuCheckboxItem
                  variant="switch"
                  checked={account.controls.visibility === "readable"}
                  onCheckedChange={(readable) =>
                    void controls({ target, visibility: readable ? "readable" : "hidden" })
                  }
                >
                  <T>Agents can read it</T>
                </MenuCheckboxItem>
                {details.kind !== "website" ? (
                  <MenuItem
                    onClick={() =>
                      void controls({
                        target,
                        permission:
                          account.controls.permission === "read-only" ? "full" : "read-only",
                      })
                    }
                  >
                    {account.controls.permission === "full"
                      ? gt("Permission: Full")
                      : gt("Permission: Read only")}
                  </MenuItem>
                ) : null}
                <ScopeSubmenu
                  environmentId={environmentId}
                  target={target}
                  scope={account.controls.scope}
                />
              </>
            ) : null}
            <MenuItem
              onClick={async () => {
                if (onRemove) {
                  onRemove();
                  return;
                }
                setBusy(true);
                await removeAccount(account, uses);
                setBusy(false);
              }}
            >
              {onRemove ? gt("Remove…") : gt("Remove")}
            </MenuItem>
          </ControlsMenu>
        </div>
      }
    />
  );
}

function ManagedAccountRow({
  row,
  environmentId,
}: {
  row: {
    kind: "extension" | "claude" | "codex" | "droid" | "scient" | "overleaf" | "chatgpt";
    instanceId?: ProviderInstanceId;
    /** A connector opens its own page, where it is repaired. */
    connectorId?: ConnectorId;
    name: string;
    detail?: string | undefined;
    /** Set only when the connection needs something, or while it is checked. */
    state?: string | undefined;
    /** It needs the person: the row offers Reconnect. */
    repair?: boolean;
    href: "/settings/extensions/installed" | "/settings/synced-folders" | "/settings/voice";
  };
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const domain = managedHost(row.detail) ?? (row.kind === "claude" ? "claude.ai" : undefined);
  // Our own logos first: the extension catalogue has no GitHub or Claude sign-in entries.
  const logo = accountIconUrl(
    row.kind === "claude"
      ? ["anthropic.com"]
      : row.kind === "codex" || row.kind === "scient"
        ? ["openai.com"]
        : domain
          ? [domain]
          : [],
    row.name,
  );
  const content = (
    <>
      {logo ? (
        <AccountLogo src={logo} className="size-10 shrink-0 rounded-[25%]" />
      ) : (
        <ExtensionIcon name={row.name} environmentId={environmentId} />
      )}
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate text-sm font-medium">{row.name}</span>
        {domain ? <span className="truncate text-xs text-muted-foreground">{domain}</span> : null}
      </span>
      {row.state ? (
        <Badge variant={row.repair ? "warning" : "outline"}>
          {row.repair ? gt("Reconnect · {state}", { state: row.state }) : row.state}
        </Badge>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">
          {row.kind === "extension" ? gt("Extensions") : MANAGED_IN[row.kind]} ›
        </span>
      )}
    </>
  );
  const className =
    "cursor-pointer flex min-h-15 items-center gap-3 rounded-lg px-4 py-2 text-foreground hover:bg-accent/40";
  if (row.connectorId)
    return (
      <Link
        to="/settings/extensions/item/connector/$connectorId"
        params={{ connectorId: row.connectorId }}
        className={className}
      >
        {content}
      </Link>
    );
  return row.instanceId ? (
    <Link
      to="/settings/extensions/store/$instanceId"
      params={{ instanceId: row.instanceId }}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <Link to={row.href} className={className}>
      {content}
    </Link>
  );
}

const SOURCE_CONTROL_VIA = {
  gh: "GitHub CLI",
  app: "Scient for GitHub",
  token: msg("Token", { $context: "GitHub sign-in method, a personal access token" }),
} as const;

/** One GitHub login with a chip per use; each chip shows that use's own state. */
function GitHubIdentityRow({ identity }: { identity: GitHubIdentity }) {
  const logo = accountIconUrl(["github.com"], identity.login);
  const via = identity.sourceControl?.via;
  const connector = identity.connector;
  const gt = useGT();
  const messages = useMessages();
  return (
    <div className="flex min-h-15 items-center gap-3 rounded-lg px-4 py-2 text-foreground">
      {logo ? <AccountLogo src={logo} className="size-10 shrink-0 rounded-[25%]" /> : null}
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate text-sm font-medium">{identity.login}</span>
        <span className="flex flex-wrap gap-1">
          {identity.sourceControl ? (
            <Badge variant="success" render={<Link to="/settings/source-control" />}>
              {via
                ? gt("Source Control · {via}", { via: messages(SOURCE_CONTROL_VIA[via]) })
                : gt("Source Control")}
            </Badge>
          ) : null}
          {connector ? (
            <Badge
              variant={connector.status === "connected" ? "success" : "warning"}
              render={
                <Link
                  to="/settings/extensions/item/connector/$connectorId"
                  params={{ connectorId: connector.connectorId }}
                />
              }
            >
              {connector.status === "connected"
                ? gt("Connector")
                : connector.status === "needs-auth"
                  ? gt("Connector · Needs sign-in")
                  : gt("Connector · Account missing")}
            </Badge>
          ) : null}
        </span>
      </span>
    </div>
  );
}

function managedHost(value: string | undefined) {
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return undefined;
  }
}

export function SavedPasswordsDialog({
  site,
  accounts,
  environmentId,
  canWrite,
  agentAccess,
  grouped,
  onEdit,
  onActivity,
  onClose,
}: {
  /** A key's Edit in Accounts: this site's logins, found and opened. */
  site?: string | undefined;
  accounts: ReadonlyArray<AccountSummary>;
  environmentId: EnvironmentId;
  canWrite: boolean;
  agentAccess: boolean;
  /** A protocol 2 server writes a group's password to every copy; an older one, to one row. */
  grouped: boolean;
  onEdit: (account: AccountSummary) => void;
  onActivity: (entries: ReadonlyArray<ActivityItem>) => void;
  onClose: () => void;
}) {
  // The page's origin from a key: its host in the box, its logins matched as the key matches them
  // until the person searches for something else.
  const atPage = site?.startsWith("https://") ? URL.parse(site) : null;
  const pageQuery = atPage?.host ?? site ?? "";
  const [query, setQuery] = useState(pageQuery);
  // Logins opened in place; a key's Edit in Accounts opens every login of its site.
  const [open, setOpen] = useState<ReadonlySet<string> | "site">(site ? "site" : new Set());
  const isOpen = (accountId: string) => open === "site" || open.has(accountId);
  const toggle = (accountId: string, ids: ReadonlyArray<string>) =>
    setOpen((current) => {
      const next = new Set(current === "site" ? ids : current);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  const gt = useGT();
  const messages = useMessages();
  const profiles = resolveBrowserProfiles(
    useClientSettings((settings) => settings.browserProfiles),
  );
  const text = query.trim().toLowerCase();
  const shown = orderSavedLogins(
    (grouped
      ? savedLogins(accounts)
      : accounts.map((account): SavedLogin => ({
          account,
          copies: [account],
          profileIds: [account.details.kind === "website" ? (account.details.profileId ?? "") : ""],
          access: account.controls.access,
        }))
    ).filter(({ copies }) =>
      copies.some((account) =>
        atPage && query === pageQuery
          ? "sites" in account.details && anySiteMatches(account.details.sites, atPage)
          : [
              account.name,
              ...("sites" in account.details ? account.details.sites : []),
              account.details.kind === "website" ? (account.details.username ?? "") : "",
            ].some((value) => value.toLowerCase().includes(text)),
      ),
    ),
  );
  // One login perhaps saved with and without its domain: side by side, each removable in one click.
  const duplicates = possibleDuplicates(shown);
  // No Undo on an older server: a login is removed from its editor there, after asking.
  const { undo, removeAccounts } = useRemoveWithUndo(environmentId);
  const profileName = (id: string) =>
    profiles.find((profile) => profile.id === (id || DEFAULT_BROWSER_PROFILE_ID))?.name;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup data-accounts-dialog data-agent-access={agentAccess} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <T>Saved passwords</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <Input
              type="search"
              aria-label={gt("Find a saved password")}
              placeholder={gt("Search {count, plural, one {{count} site} other {{count} sites}}", {
                count: accounts.length,
              })}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
              {shown.map((login) => {
                const { account, copies } = login;
                const username =
                  account.details.kind === "website" ? account.details.username : undefined;
                const expanded = isOpen(account.accountId);
                const openLogin = () =>
                  toggle(
                    account.accountId,
                    shown.map((item) => item.account.accountId),
                  );
                return (
                  <Fragment key={account.accountId}>
                    <AccountRow
                      account={account}
                      login={login}
                      environmentId={environmentId}
                      canWrite={canWrite}
                      onEdit={() => onEdit(account)}
                      onOpen={openLogin}
                      expanded={expanded}
                      onActivity={onActivity}
                      detail={[
                        username,
                        login.profileIds.map(profileName).filter(Boolean).join(", "),
                        // The password's own state, apart from each copy's session.
                        copies.some(
                          (copy) =>
                            copy.secrets.password?.refusedAt !== undefined ||
                            copy.signIn?.state === "password-rejected",
                        )
                          ? gt("Password refused")
                          : login.workedAt
                            ? gt("Worked {time}", {
                                time: formatRelativeTimeLabel(login.workedAt, undefined, messages),
                              })
                            : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      aside={
                        duplicates.has(account.accountId) ? (
                          <span className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground">
                              <T>Possible duplicate</T>
                            </span>
                            {undo ? (
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={!canWrite}
                                aria-label={gt("Remove {name}", { name: username ?? account.name })}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void removeAccounts(copies, username ?? account.name);
                                }}
                              >
                                <T>Remove</T>
                              </Button>
                            ) : null}
                          </span>
                        ) : copies.length > 1 ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            aria-expanded={expanded}
                            onClick={(event) => {
                              event.stopPropagation();
                              openLogin();
                            }}
                          >
                            {gt("{count} copies", { count: copies.length })}
                          </Button>
                        ) : undefined
                      }
                    />
                    {expanded ? (
                      <SavedLoginDetails
                        environmentId={environmentId}
                        login={login}
                        profileName={profileName}
                        canWrite={canWrite}
                        onEdit={() => onEdit(account)}
                      />
                    ) : null}
                    {expanded && copies.length > 1
                      ? copies.map((copy) => (
                          <AccountRow
                            key={copy.accountId}
                            account={copy}
                            environmentId={environmentId}
                            canWrite={canWrite}
                            onEdit={() => onEdit(copy)}
                            onActivity={onActivity}
                            detail={[
                              copy.details.kind === "website" ? copy.details.username : undefined,
                              profileName(
                                copy.details.kind === "website"
                                  ? (copy.details.profileId ?? "")
                                  : "",
                              ),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          />
                        ))
                      : null}
                  </Fragment>
                );
              })}
              {shown.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  <T>No saved passwords match</T>
                </div>
              ) : null}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

const siteKey = (account: AccountSummary) =>
  "sites" in account.details
    ? (account.details.sites[0]?.replace(/^https:\/\//, "").toLowerCase() ?? "")
    : "";

/**
 * On Main's row for a site: the profile Main uses there when Main's own sign-in doesn't work and
 * another profile's does. Google refuses signing in from Scient's browser, so Main gets Google
 * only as a copy, or through importing a browser profile that has it.
 */
export function MainSiteChoice({
  environmentId,
  account,
  accounts,
  profiles,
  onImport,
  onChromeWindow,
}: {
  environmentId: EnvironmentId;
  /** Main's row for the site. */
  account: AccountSummary;
  accounts: ReadonlyArray<AccountSummary>;
  profiles: ReturnType<typeof mergeProfiles>;
  onImport?: () => void;
  /** Signs Main in to Google in a Chrome window; absent where the desktop can't. */
  onChromeWindow?: (() => void) | undefined;
}) {
  const openBrowser = useAccountBrowser(environmentId);
  const gt = useGT();
  const messages = useMessages();
  const site = "sites" in account.details ? account.details.sites[0] : undefined;
  const key = siteKey(account);
  const group = accounts.filter((row) => isBrowserSignIn(row) && siteKey(row) === key);
  const pageUrl = site ? (site.startsWith("https://") ? site : `https://${site}`) : undefined;
  const identities = siteIdentities(group, pageUrl).map((identity) => identity.profileId);
  const mainWorks = identities.includes(DEFAULT_BROWSER_PROFILE_ID);
  const using = mainWorks ? undefined : profiles.find((profile) => profile.id === identities[0]);
  const google = site === GOOGLE_SITE;
  const usingRow = group.find(
    ({ details }) => details.kind === "website" && details.profileId === using?.id,
  );
  // Main's Google doesn't work and no profile here holds one that does.
  const googleMissing = google && !using && !mainWorks;
  if (!(using && pageUrl) && !(googleMissing && onImport)) return null;
  const copyIntoMain = async (row: AccountSummary, from: string) => {
    const outcome = await copySignInIntoMain(environmentId, row);
    if (outcome === "copied" || outcome === "same")
      toastManager.add({
        type: "success",
        title: m(msg("Copied {from}''s Google sign-in into Main", { from })),
      });
    else if (outcome === "conflict")
      toastManager.add({
        type: "info",
        title: m(msg("Main already holds a Google sign-in")),
        description: m(msg("Sign out of Google in Main, then copy again.")),
      });
    else toastManager.add({ type: "error", title: m(msg("Couldn't copy the sign-in into Main")) });
  };
  return (
    <span className="flex items-center gap-1">
      {using ? (
        <span className="text-xs text-muted-foreground">
          <T>
            Using <Var>{using.name}</Var>
          </T>
        </span>
      ) : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Who Main uses on {site}", { site: account.name })}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {googleMissing && onImport ? (
            <MenuGroup>
              <MenuGroupLabel className="max-w-64">{messages(GOOGLE_SIGNED_OUT)}</MenuGroupLabel>
              {onChromeWindow ? (
                <MenuItem onClick={onChromeWindow}>{messages(CHROME_WINDOW_ACTION)}</MenuItem>
              ) : null}
              <MenuItem onClick={onImport}>
                <T>Import from a browser…</T>
              </MenuItem>
            </MenuGroup>
          ) : google && using && usingRow ? (
            <MenuItem onClick={() => void copyIntoMain(usingRow, using.name)}>
              <T>
                Copy from <Var>{using.name}</Var>
              </T>
            </MenuItem>
          ) : using && pageUrl ? (
            <MenuItem onClick={() => void openBrowser(pageUrl, using.id)}>
              <T>
                Open in <Var>{using.name}</Var>
              </T>
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </span>
  );
}

/** One row standing for a list that grows on its own, opening it in a dialog. */
function ListRow({
  id,
  icon,
  title,
  openLabel,
  detail,
  description,
  onOpen,
}: {
  /** Settings search scrolls to this. */
  id?: string;
  icon: ReactNode;
  title: string;
  /** The row's accessible name, for example "Show saved passwords". */
  openLabel: string;
  detail: string;
  description?: string;
  onOpen: () => void;
}) {
  return (
    <SettingsRow
      id={id}
      {...clickableAccountRow(onOpen)}
      aria-label={openLabel}
      description={description}
      descriptionSize="compact"
      title={
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground">
            {icon}
          </span>
          <span className="grid min-w-0 gap-1">
            <span className="truncate text-left">{title}</span>
            <span className="truncate text-xs text-muted-foreground">{detail}</span>
          </span>
        </span>
      }
      control={<ChevronRightIcon className="size-4 text-muted-foreground" />}
    />
  );
}

function ListDialog({
  title,
  onClose,
  children,
  agentAccess = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** The global agent switch, which dims every access chip when off. */
  agentAccess?: boolean;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup data-accounts-dialog data-agent-access={agentAccess} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border">{children}</div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The line under a key's name: its service and what uses it. */
const keyDetail = (row: ApiKeyRow) =>
  [row.service, [...new Set(row.uses.map((use) => use.label))].join(", ")]
    .filter(Boolean)
    .join(" · ");

/** Every key, wherever it is stored. Keeping one in Accounts makes it the copy its users follow. */
export function ApiKeysDialog({
  rows,
  roots,
  environmentId,
  canWrite,
  consumersIncomplete = false,
  agentAccess = true,
  onEdit,
  onActivity,
  onKept,
  onClose,
}: {
  rows: ReadonlyArray<ApiKeyRow>;
  roots: ReadonlyArray<string>;
  environmentId: EnvironmentId;
  canWrite: boolean;
  consumersIncomplete?: boolean;
  agentAccess?: boolean;
  onEdit: (account: AccountSummary) => void;
  onActivity: (entries: ReadonlyArray<ActivityItem>) => void;
  onKept: (file: string, name: string) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const keeping = useRef(new Set<string>());
  const link = useAccountCommand(accountsState.linkKey, environmentId);
  const unlink = useAccountCommand(accountsState.unlinkKey, environmentId);
  const keepPlainKey = useAccountCommand(accountsState.keepPlainKey, environmentId);
  const gt = useGT();
  const messages = useMessages();
  const sameKeys = useAccounts(environmentId).data?.sameKeys;
  const savedKeys = keyOptions(
    { accounts: rows.flatMap((row) => (row.stored === "accounts" ? [row.account] : [])), sameKeys },
    { kind: "variable", id: "" },
    (account) => variableKeyFits(account),
  );
  const [affectedKey, setAffectedKey] = useState<{
    row: Extract<ApiKeyRow, { stored: "accounts" }>;
    kind: "replace" | "remove";
  } | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const { undo, removeAccount } = useRemoveWithUndo(environmentId);
  const usesOf = (row: ApiKeyRow) => [...new Set(row.uses.map(({ label }) => label))];
  const open = (href: ApiKeyRow["uses"][number]["href"]) => {
    onClose();
    void navigate({ to: href });
  };
  const openLabel = (label: string, href: ApiKeyRow["uses"][number]["href"]) =>
    href === "/settings/custom-models"
      ? gt("Open Custom models")
      : gt("Open {label} settings", { label });
  const keep = async (row: ApiKeyRow) => {
    if (keeping.current.has(row.id)) return;
    keeping.current.add(row.id);
    const result =
      row.stored === "agent"
        ? await link({ instanceId: row.instanceId, variable: row.variable })
        : row.stored === "files"
          ? await keepPlainKey({ roots, file: row.file, name: row.name })
          : undefined;
    keeping.current.delete(row.id);
    if (!result?.ok) return;
    if (row.stored === "files") onKept(row.file, row.name);
    toastManager.add({
      type: "success",
      title: m(msg("Kept {name} in Accounts", { name: row.name })),
    });
  };
  return (
    <ListDialog title={gt("API keys")} onClose={onClose} agentAccess={agentAccess}>
      {rows.map((row) =>
        row.stored === "accounts" ? (
          <AccountRow
            key={row.id}
            account={row.account}
            environmentId={environmentId}
            canWrite={canWrite}
            onEdit={() => onEdit(row.account)}
            onActivity={onActivity}
            detail={
              <>
                {row.service || messages(KIND_LABELS["api-key"])}
                {row.uses.length ? (
                  <span className="block whitespace-normal">
                    {gt("Used by {consumers}", {
                      consumers: new Intl.ListFormat(undefined, { type: "conjunction" }).format(
                        row.uses.map((use) => keyUseLabel({ ...use, refused: false }, messages)),
                      ),
                    })}
                  </span>
                ) : null}
                {row.uses.some(({ link }) => link) &&
                (row.account.controls.access === "off" ||
                  row.account.controls.scope.type !== "all-projects") ? (
                  <span className="block whitespace-normal">
                    <T>Restart to update</T>
                  </span>
                ) : null}
                {row.uses.some((use) => use.refused) ? (
                  <span className="block whitespace-normal text-destructive-foreground">
                    {gt("Refused by {uses}", {
                      uses: new Intl.ListFormat(undefined, { type: "conjunction" }).format(
                        row.uses.filter((use) => use.refused).map((use) => keyUseLabel(use)),
                      ),
                    })}
                  </span>
                ) : null}
                {row.files.length ? (
                  <span className="block whitespace-normal">
                    {gt("From {files}", { files: row.files.join(", ") })}
                  </span>
                ) : null}
              </>
            }
            uses={usesOf(row)}
            {...(undo ? {} : { onRemove: () => setAffectedKey({ row, kind: "remove" }) })}
            menu={
              <>
                <MenuItem onClick={() => setAffectedKey({ row, kind: "replace" })}>
                  <T>Replace key…</T>
                </MenuItem>
                {[
                  ...new Map(
                    row.uses.filter((use) => !use.connectorId).map((use) => [use.label, use.href]),
                  ).entries(),
                ].map(([label, href]) => (
                  <MenuItem key={label} onClick={() => open(href)}>
                    {openLabel(label, href)}
                  </MenuItem>
                ))}
                {/* Each connector opens its own page, where it is repaired. */}
                {row.uses.flatMap((use) =>
                  use.connectorId
                    ? [
                        <MenuItem
                          key={`connector:${use.connectorId}`}
                          onClick={() => {
                            onClose();
                            void navigate({
                              to: "/settings/extensions/item/connector/$connectorId",
                              params: { connectorId: use.connectorId! },
                            });
                          }}
                        >
                          {gt("Open {name}", { name: use.consumerName ?? use.label })}
                        </MenuItem>,
                      ]
                    : [],
                )}
                {row.uses.flatMap(({ label, link: target }) =>
                  target
                    ? [
                        <MenuItem
                          key={`${target.instanceId}:${target.variable}`}
                          onClick={() => void unlink(target)}
                        >
                          <T>
                            Stop using in <Var>{label}</Var>
                          </T>
                        </MenuItem>,
                      ]
                    : [],
                )}
              </>
            }
          />
        ) : (
          <SettingsRow
            key={row.id}
            {...(row.uses[0] ? clickableAccountRow(() => open(row.uses[0]!.href)) : {})}
            aria-label={
              row.uses[0] ? gt("Open where {name} is used", { name: row.name }) : undefined
            }
            title={
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted">
                  <KeyRoundIcon className="size-4 text-muted-foreground" />
                </span>
                <span className="grid min-w-0 gap-1">
                  <span className="truncate text-left">{row.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {onlyIn(row, messages) ?? keyDetail(row)}
                  </span>
                </span>
              </span>
            }
            control={
              <span className="flex items-center gap-2">
                {row.stored === "agent" && savedKeys.length ? (
                  <span className="w-36 shrink-0">
                    <ApiKeyAccountPicker
                      aria-label={gt("Key in Accounts for {name}", { name: row.name })}
                      emptyLabel={gt("Its own key")}
                      options={savedKeys}
                      size="xs"
                      value=""
                      disabled={!canWrite}
                      onChange={(event) => {
                        const accountId = event.currentTarget.value;
                        if (accountId)
                          void link({
                            instanceId: row.instanceId,
                            variable: row.variable,
                            accountId: AccountId.make(accountId),
                          });
                      }}
                    />
                  </span>
                ) : null}
                {row.stored === "agent" || row.stored === "files" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canWrite}
                    onClick={() => void keep(row)}
                  >
                    <T>Keep in Accounts</T>
                  </Button>
                ) : null}
              </span>
            }
          />
        ),
      )}
      {affectedKey !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !removingBusy) setAffectedKey(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>
                {affectedKey.kind === "remove"
                  ? gt("Remove {name}?", { name: affectedKey.row.name })
                  : gt("Replace {name}?", { name: affectedKey.row.name })}
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {consumersIncomplete ? (
                <p className="mb-3 text-sm text-muted-foreground">
                  <T>
                    Could not check everything that uses this key. Try again before removing it.
                  </T>
                </p>
              ) : null}
              {affectedKey.row.uses.length ? (
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    {affectedKey.kind === "remove"
                      ? gt("These connections will need a key again.")
                      : gt("These connections will use the replacement key.")}
                  </p>
                  <ul className="list-disc pl-5">
                    {affectedKey.row.uses.map((use) => (
                      <li
                        key={
                          use.href +
                          ":" +
                          (use.consumerId ?? use.link?.variable ?? use.consumerName ?? use.label)
                        }
                      >
                        {use.consumerName ? use.label + " · " + use.consumerName : use.label}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={removingBusy}
                  onClick={() => setAffectedKey(null)}
                >
                  <T>Cancel</T>
                </Button>
                <Button
                  variant={affectedKey.kind === "remove" ? "destructive" : "default"}
                  disabled={removingBusy || (consumersIncomplete && affectedKey.kind === "remove")}
                  onClick={async () => {
                    if (affectedKey.kind === "replace") {
                      setAffectedKey(null);
                      onEdit(affectedKey.row.account);
                      return;
                    }
                    setRemovingBusy(true);
                    const removed = await removeAccount(
                      affectedKey.row.account,
                      usesOf(affectedKey.row),
                    );
                    setRemovingBusy(false);
                    if (removed) setAffectedKey(null);
                  }}
                >
                  {affectedKey.kind === "remove" ? gt("Remove key") : gt("Continue")}
                </Button>
              </div>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </ListDialog>
  );
}

/** Enabled, Off or needing Full Disk Access, on the computer that reads the codes. */
function signInCodesDetail(snapshot: AccountsSnapshot, gt: ReturnType<typeof useGT>) {
  const host = snapshot.codeSourcesHost;
  if (!host)
    return snapshot.codeSources?.messages
      ? gt("Messages", { $context: "the macOS Messages app" })
      : gt("You type them in");
  if (!snapshot.codeSources?.messages) return gt("Off on {computer}", { computer: host.computer });
  return host.readable
    ? gt("Enabled on {computer}", { computer: host.computer })
    : gt("Needs Full Disk Access on {computer}", { computer: host.computer });
}

/** Codes from Messages and Mail on the server's Mac, where sign-ins run. */
export function SignInCodesDialog({
  sources,
  host,
  environmentId,
  canWrite,
  onClose,
}: {
  sources: AccountCodeSources;
  host: AccountsSnapshot["codeSourcesHost"];
  environmentId: EnvironmentId;
  canWrite: boolean;
  onClose: () => void;
}) {
  const set = useAccountCommand(accountsState.setCodeSources, environmentId);
  const check = useAccountCommand(accountsState.checkCodeSources, environmentId);
  const { refresh } = useAccounts(environmentId);
  // Only the Mac the server runs on can grant it, from its own desktop app; elsewhere, name it.
  // A primary the desktop reaches on another computer is not this Mac.
  const onServerMac =
    useAtomValue(sameHostEnvironmentIdsAtom).has(environmentId) &&
    window.desktopBridge?.openSystemSettings !== undefined;
  const remote = onServerMac ? undefined : host;
  const [chosen, setChosen] = useState(sources);
  const [switched, setSwitched] = useState<boolean | undefined>(undefined);
  // The freshest answer wins: the switch's own check, else the snapshot's.
  const needsAccess = switched ?? (host ? !host.readable : false);
  // Opened Full Disk Access, then came back: still denied asks for a restart.
  const [opened, setOpened] = useState(false);
  const [returned, setReturned] = useState(false);
  const recheck = useEffectEvent(async () => {
    // A new reader on the server, writing nothing: every row then shows its answer, and reading
    // is never turned back on from this dialog's view of the switch.
    const result = await check({});
    if (!result.ok) return;
    setSwitched(result.value.messagesNeedAccess);
    refresh();
    setReturned(true);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Listens for the window's return from System Settings while the row waits on Full Disk Access.
  useEffect(() => {
    if (!opened) return;
    const back = () => {
      if (document.visibilityState !== "hidden") void recheck();
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [opened]);
  const gt = useGT();
  const change = async (next: AccountCodeSources) => {
    setChosen(next);
    const result = await set(next);
    if (result.ok) setSwitched(result.value.messagesNeedAccess);
    else setChosen(sources);
  };
  const relaunch = window.desktopBridge?.accounts?.relaunch;
  const title = host
    ? gt("Codes from {computer}", { computer: host.computer })
    : gt("Codes from this Mac");
  return (
    <ListDialog title={gt("Sign-in codes")} onClose={onClose}>
      <SettingsRow
        title={title}
        description={gt("Messages and Mail. Needs Full Disk Access.")}
        control={
          <Switch
            aria-label={title}
            checked={chosen.messages}
            disabled={!canWrite}
            onCheckedChange={(messages) => void change({ messages })}
          />
        }
      />
      {needsAccess && chosen.messages ? (
        <SettingsRow
          title={
            remote
              ? gt("Allow Scient in Full Disk Access on {computer}", { computer: remote.computer })
              : gt("macOS hasn't given Scient access")
          }
          control={
            remote ? null : returned && relaunch ? (
              <Button size="xs" variant="outline" onClick={() => void relaunch()}>
                <T>Restart Scient</T>
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setOpened(true);
                  setReturned(false);
                  const open = window.desktopBridge?.accounts?.openFullDiskAccess;
                  void (
                    open ? open() : readLocalApi()?.shell.openSystemSettings("full-disk-access")
                  )?.catch(() => undefined);
                }}
              >
                <T>Open Full Disk Access</T>
              </Button>
            )
          }
        />
      ) : null}
    </ListDialog>
  );
}

function AccountsContent({
  environmentId,
  snapshot,
  canWrite,
  link,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  canWrite: boolean;
  link: AccountsLink;
}) {
  const chromeSignIn = useChromeSignIn(environmentId);
  const gt = useGT();
  const messages = useMessages();
  const linked = snapshot.accounts.find(({ accountId }) => accountId === link.account) ?? null;
  const linkedDialog =
    link.show === "api-keys" || linked?.details.kind === "api-key"
      ? ("api-keys" as const)
      : link.show === "passwords" || (linked && isSavedPassword(linked))
        ? ("passwords" as const)
        : null;
  const [dialog, setDialog] = useState<
    "add" | "import" | "1password" | "passwords" | "apps" | "sign-in-codes" | "api-keys" | null
  >(linkedDialog);
  const [editing, setEditing] = useState<AccountSummary | null>(linked);
  // A new link on the open page opens its item, as following it from elsewhere does.
  const [shownLink, setShownLink] = useState(link);
  if (
    shownLink.account !== link.account ||
    shownLink.show !== link.show ||
    shownLink.site !== link.site
  ) {
    setShownLink(link);
    setDialog(linkedDialog);
    setEditing(linked);
  }
  const [checking, setChecking] = useState(false);
  const [plainKeys, setPlainKeys] = useState<ReadonlyArray<AccountPlainKey>>([]);
  const projectRoots = useProjects()
    .filter((project) => project.environmentId === environmentId)
    .map((project) => project.workspaceRoot);
  const findPlainKeys = useAccountCommand(accountsState.plainKeys, environmentId);
  const scannedRoots = projectRoots.join("\u0000");
  const scanPlainKeys = useEffectEvent((roots: ReadonlyArray<string>) => findPlainKeys({ roots }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Looks once per set of projects when the page opens; the files aren't watched.
  useEffect(() => {
    if (!canWrite) return;
    let live = true;
    void scanPlainKeys(scannedRoots ? scannedRoots.split("\u0000") : []).then((result) => {
      if (live && result.ok) setPlainKeys(result.value);
    });
    return () => {
      live = false;
    };
  }, [canWrite, scannedRoots]);
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const inventory = useEnvironmentQuery(extensionsInventory({ environmentId, input: {} }));
  const keys = apiKeyRows({
    accounts: snapshot.accounts,
    keyLinks: snapshot.keyLinks,
    instances: serverSettings?.providerInstances ?? {},
    customModelKeys: snapshot.customModelKeys,
    keyConsumers: snapshot.keyConsumers,
    keyRefusals: snapshot.keyRefusals,
    connectors: inventory.data?.connectors,
    libraryKeys: serverSettings?.scientSources?.keys,
    textGenerators: serverSettings?.textGenerators,
    plainKeys,
    driverName: (driver) =>
      PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES] ?? driver,
    resolve: messages,
  });
  const keysToKeep = keys.filter((row) => onlyIn(row, messages) !== undefined).length;
  const checkAll = useAccountCommand(accountsState.check, environmentId);
  const profiles = mergeProfiles(
    useClientSettings((settings) => settings.browserProfiles),
    snapshot.profiles,
  );
  const [activity, setActivity] = useState<ReadonlyArray<ActivityItem> | null>(null);
  const passwordFileRef = useRef<HTMLInputElement>(null);
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const providerInventory = useProviderInventory({
    environmentId,
    providers,
    roots: [],
    projectsKnown: true,
    enabled: true,
  });
  const signedOut = signedOutAgents(providers);
  const providerRows = steadyProviderRows(providerRowsCache, environmentId, {
    connection: Option.getOrNull(usePreparedConnection(environmentId)),
    canRead: useEnvironmentScope(environmentId, AuthOrchestrationReadScope),
    permitted: useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId)),
    providers,
    inventory: providerInventory.providers,
  });
  const setAccess = useAccountCommand(accountsState.setAgentAccess, environmentId);
  const setRenew = useAccountCommand(accountsState.setRenewAutomatically, environmentId);
  // Lists that grow on their own (saved passwords, sign-ins managed elsewhere) are one row each,
  // and browser sign-ins are under their profiles, so the page shows what was added on purpose.
  const savedPasswords = snapshot.accounts.filter(isSavedPassword);
  const universities = shownUniversities(snapshot);
  const removeUniversity = useRemoveUniversity(environmentId);
  const needYou = savedPasswords.filter(({ signIn }) => signIn?.state === "needs-you").length;
  const importingPasswords = useImportingPasswords();
  const externalIdentitiesQuery = useAccountsExternalIdentities(environmentId);
  const managedElsewhereWithExternal = [
    ...(externalIdentitiesQuery.data?.identities ?? []),
    ...(snapshot.managedElsewhere ?? []).filter(
      (row) =>
        row.kind !== "github" ||
        !(externalIdentitiesQuery.data?.identities ?? []).some(
          (ext) => ext.kind === row.kind && ext.id === row.id,
        ),
    ),
  ];
  const githubRows = githubIdentities(
    managedElsewhereWithExternal,
    inventory.data?.connectors ?? [],
  );
  const overleaf = useOverleafTokenSaved(environmentId);
  const chatGpt = useChatGptDictation(environmentId).connection;
  // Connections you sign in to or give a key. GitHub's are its identities above. A broken one
  // stays listed with what it needs, and opens where it is repaired.
  const managedRows = [
    ...providerRows.map(({ connection, ...row }) => ({
      ...row,
      state:
        connection === "needs-sign-in"
          ? messages(msg("Needs sign-in"))
          : connection === "failed"
            ? messages(msg("Not working"))
            : connection === "checking"
              ? messages(msg("Checking…"))
              : undefined,
      repair: connection === "needs-sign-in" || connection === "failed",
    })),
    ...(inventory.data?.connectors.filter(holdsCredential).map((connector) => ({
      kind: "extension" as const,
      id: connector.connectorId,
      connectorId: connector.connectorId,
      name: connector.displayName,
      detail: new URL(connector.url).origin,
      state:
        connector.status === "needs-auth"
          ? messages(msg("Needs sign-in"))
          : connector.status === "needs-credential"
            ? messages(msg("Key missing"))
            : undefined,
      repair: connector.status !== "connected",
      href: "/settings/extensions/installed" as const,
    })) ?? []),
    ...(overleaf.saved
      ? [
          {
            kind: "overleaf" as const,
            id: "overleaf",
            name: "Overleaf",
            detail: "overleaf.com",
            href: "/settings/synced-folders" as const,
          },
        ]
      : []),
    ...(chatGpt.choices.length
      ? [
          {
            kind: "chatgpt" as const,
            id: "chatgpt-dictation",
            name: messages(msg("ChatGPT dictation")),
            detail: "chatgpt.com",
            state: chatGpt.ready ? undefined : messages(msg("Signed out")),
            href: "/settings/voice" as const,
          },
        ]
      : []),
  ];
  return (
    <div className="scient-accounts-settings grid gap-8" data-agent-access={snapshot.agentAccess}>
      <NeedsYouBand environmentId={environmentId} snapshot={snapshot} canWrite={canWrite} />
      <RemovedBand environmentId={environmentId} snapshot={snapshot} canWrite={canWrite} />
      <ProfileChangesBand environmentId={environmentId} snapshot={snapshot} canWrite={canWrite} />
      <SettingsSection
        id="accounts-list"
        title={gt("Accounts")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canWrite || checking}
            onClick={async () => {
              setChecking(true);
              window.dispatchEvent(new Event("scient-accounts-session-changed"));
              const result = await checkAll({});
              setChecking(false);
              if (result.ok)
                toastManager.add({
                  type: "success",
                  title: result.value.alreadyRunning
                    ? m(msg("Already checking your accounts"))
                    : result.value.checked
                      ? result.value.skipped
                        ? m(
                            msg(
                              "{count, plural, one {Checked {count} sign-in} other {Checked {count} sign-ins}} · skipped {skipped}",
                              { count: result.value.checked, skipped: result.value.skipped },
                            ),
                          )
                        : m(
                            msg(
                              "{count, plural, one {Checked {count} sign-in} other {Checked {count} sign-ins}}",
                              { count: result.value.checked },
                            ),
                          )
                      : m(msg("No sign-ins to check yet")),
                });
            }}
          >
            {checking ? gt("Checking…") : gt("Check my accounts")}
          </Button>
        }
        titleAction={
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={gt("Add", { $context: "verb, adds an account" })}
                  disabled={!canWrite}
                />
              }
            >
              <PlusIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setDialog("add")}>
                <T>Add an account…</T>
              </MenuItem>
              <MenuItem onClick={() => passwordFileRef.current?.click()}>
                <T>Import passwords…</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
      >
        <AccountsStatusLine environmentId={environmentId} />
        <SettingsRow
          id="accounts-agent-access"
          title={gt("Let agents use your accounts")}
          control={
            <Switch
              aria-label={gt("Let agents use your accounts")}
              checked={snapshot.agentAccess}
              disabled={!canWrite}
              onCheckedChange={(enabled) => void setAccess({ enabled })}
            />
          }
        />
        {snapshot.renewAutomatically === undefined ? null : (
          <SettingsRow
            id="accounts-renew-automatically"
            title={gt("Renew sign-ins automatically")}
            control={
              <Switch
                aria-label={gt("Renew sign-ins automatically")}
                checked={snapshot.renewAutomatically}
                disabled={!canWrite}
                onCheckedChange={(enabled) => void setRenew({ enabled })}
              />
            }
          />
        )}
        {!snapshot.accounts.length ? (
          <SettingsRow
            title={gt("No accounts")}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite}
                onClick={() => setDialog("add")}
              >
                <T>Add an account</T>
              </Button>
            }
          />
        ) : null}
        {snapshot.accounts
          .filter(
            (account) =>
              !isSavedPassword(account) &&
              !isBrowserSignIn(account) &&
              account.details.kind !== "api-key" &&
              // One row per university: the rest of its rows are in its menu.
              (groupOf(universities, account.accountId)?.key ?? account.accountId) ===
                account.accountId,
          )
          .map((account) => {
            const university = groupOf(universities, account.accountId);
            return (
              <AccountRow
                key={account.accountId}
                account={university ? { ...account, name: university.name } : account}
                environmentId={environmentId}
                canWrite={canWrite}
                onEdit={() => setEditing(account)}
                onActivity={setActivity}
                {...(university
                  ? {
                      menu: (
                        <UniversityRowMenu
                          environmentId={environmentId}
                          group={university}
                          onEdit={setEditing}
                        />
                      ),
                    }
                  : {})}
                {...(university && university.rows.length > 1
                  ? {
                      onRemove: () => removeUniversity(university),
                    }
                  : {})}
              />
            );
          })}
        {savedPasswords.length || importingPasswords ? (
          <ListRow
            id="accounts-saved-passwords"
            icon={<KeyRoundIcon />}
            title={gt("Saved passwords")}
            openLabel={gt("Show saved passwords")}
            detail={
              importingPasswords
                ? gt("Importing… {count, plural, one {{count} site} other {{count} sites}}", {
                    count: savedPasswords.length,
                  })
                : [
                    gt("{count, plural, one {{count} site} other {{count} sites}}", {
                      count: savedPasswords.length,
                    }),
                    needYou
                      ? gt("{count, plural, one {{count} needs you} other {{count} need you}}", {
                          count: needYou,
                        })
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")
            }
            onOpen={() => setDialog("passwords")}
          />
        ) : null}
        {snapshot.detachedKeyLinks?.length ? (
          <SettingsRow
            title={snapshot.detachedKeyLinks
              .map(({ instanceId, variable }) => instanceId + " · " + variable)
              .join(", ")}
            description={gt("No longer linked")}
          />
        ) : null}
        {keys.length ? (
          <ListRow
            id="accounts-api-keys"
            icon={<KeyRoundIcon />}
            title={gt("API keys")}
            openLabel={gt("Show api keys")}
            detail={[
              gt("{count, plural, one {{count} key} other {{count} keys}}", { count: keys.length }),
              keysToKeep ? gt("{count} not in Accounts", { count: keysToKeep }) : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
            onOpen={() => setDialog("api-keys")}
          />
        ) : null}
        {snapshot.codeSourcesHost ||
        // A server older than protocol 2 doesn't say where it runs; a Mac viewer is the best guess.
        ((snapshot.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL_2 &&
          isMacPlatform(navigator.platform)) ? (
          <ListRow
            id="accounts-sign-in-codes"
            icon={<MessageSquareIcon />}
            title={gt("Sign-in codes")}
            openLabel={gt("Show sign-in codes")}
            detail={signInCodesDetail(snapshot, gt)}
            onOpen={() => setDialog("sign-in-codes")}
          />
        ) : null}
        {managedRows.length || githubRows.length || signedOut.length ? (
          <ListRow
            icon={<LinkIcon />}
            title={gt("Apps and connectors")}
            openLabel={gt("Show apps and connectors")}
            detail={[
              signedOut.length ? gt("{count} signed out", { count: signedOut.length }) : undefined,
              ...githubRows.map((row) => row.login),
              ...managedRows.map((row) => row.name),
            ]
              .filter(Boolean)
              .join(", ")}
            onOpen={() => setDialog("apps")}
          />
        ) : null}
      </SettingsSection>
      <BrowserProfiles
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        onImport={() => setDialog("import")}
        onActivity={setActivity}
        onChromeWindow={chromeSignIn.available ? chromeSignIn.start : undefined}
        renderSignIn={(account, menu) => (
          <AccountRow
            key={account.accountId}
            account={account}
            environmentId={environmentId}
            canWrite={canWrite}
            onEdit={() => setEditing(account)}
            onActivity={setActivity}
            menu={menu}
            aside={
              account.details.kind === "website" &&
              account.details.profileId === DEFAULT_BROWSER_PROFILE_ID ? (
                <MainSiteChoice
                  environmentId={environmentId}
                  account={account}
                  accounts={snapshot.accounts}
                  profiles={profiles}
                  onImport={() => setDialog("import")}
                  onChromeWindow={
                    chromeSignIn.available
                      ? () => chromeSignIn.start({ id: DEFAULT_BROWSER_PROFILE_ID, name: "Main" })
                      : undefined
                  }
                />
              ) : null
            }
          />
        )}
      />
      <RemoteComputers environmentId={environmentId} snapshot={snapshot} canWrite={canWrite} />
      <PasswordStores
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        onConnect={() => setDialog("1password")}
      />
      <PasswordFileInput
        environmentId={environmentId}
        canWrite={canWrite}
        inputRef={passwordFileRef}
      />
      {dialog === "add" || editing ? (
        <AccountDialog
          environmentId={environmentId}
          snapshot={snapshot}
          // The row as the live snapshot has it now (a removed version's Undo shows at once).
          account={
            editing
              ? (snapshot.accounts.find(({ accountId }) => accountId === editing.accountId) ??
                editing)
              : null
          }
          canWrite={canWrite}
          onClose={() => {
            setEditing(null);
            // Editing from a list returns to it.
            if (dialog !== "passwords" && dialog !== "api-keys") setDialog(null);
          }}
        />
      ) : null}
      {chromeSignIn.dialog}
      {dialog === "import" ? (
        <BrowserImportDialog
          environmentId={environmentId}
          canWrite={canWrite}
          snapshot={snapshot}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "passwords" ? (
        <SavedPasswordsDialog
          key={link.site ?? ""}
          site={link.show === "passwords" ? link.site : undefined}
          accounts={savedPasswords}
          environmentId={environmentId}
          canWrite={canWrite}
          agentAccess={snapshot.agentAccess}
          grouped={(snapshot.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2}
          onEdit={setEditing}
          onActivity={setActivity}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "api-keys" ? (
        <ApiKeysDialog
          rows={keys}
          roots={projectRoots}
          environmentId={environmentId}
          canWrite={canWrite}
          consumersIncomplete={snapshot.keyConsumersIncomplete === true}
          agentAccess={snapshot.agentAccess}
          onEdit={setEditing}
          onActivity={setActivity}
          onKept={(file, name) =>
            setPlainKeys((current) =>
              current.map((item) =>
                item.file === file && item.name === name ? { ...item, kept: true } : item,
              ),
            )
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "sign-in-codes" ? (
        <SignInCodesDialog
          sources={snapshot.codeSources ?? { messages: false }}
          host={snapshot.codeSourcesHost}
          environmentId={environmentId}
          canWrite={canWrite}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "apps" ? (
        <ListDialog title={gt("Apps and connectors")} onClose={() => setDialog(null)}>
          {signedOut.map((provider) => (
            <SettingsRow
              key={provider.instanceId}
              title={provider.displayName ?? provider.instanceId}
              description={gt("Signed out")}
              control={
                <Button size="xs" variant="outline" render={<Link to="/settings/providers" />}>
                  {gt("Reconnect")}
                </Button>
              }
            />
          ))}
          {githubRows.map((identity) => (
            <GitHubIdentityRow key={identity.id} identity={identity} />
          ))}
          {managedRows.map((row) => (
            <ManagedAccountRow
              key={`${row.kind}:${row.id}`}
              row={row}
              environmentId={environmentId}
            />
          ))}
        </ListDialog>
      ) : null}
      {dialog === "1password" ? (
        <OnePasswordDialog
          environmentId={environmentId}
          canWrite={canWrite}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {activity ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setActivity(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>
                <T>Activity</T>
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {activity.map((entry) => (
                <div key={JSON.stringify(entry)} className="py-2 text-xs">
                  <time className="text-muted-foreground">
                    {new Date(entry.at).toLocaleString()}
                  </time>{" "}
                  ·{" "}
                  {activityItemLine(
                    entry,
                    activityConversation(entry, environmentId, messages),
                    messages,
                  )}
                </div>
              ))}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}

/** The conversation behind an activity entry; the user's own check has none. */
function AccountsEnvironment({
  environmentId,
  link,
}: {
  environmentId: EnvironmentId;
  link: AccountsLink;
}) {
  const accounts = useAccounts(environmentId);
  const data = useWebsiteSessions(environmentId, accounts.data);
  const gt = useGT();
  if (!data)
    return (
      <SettingsSection title={gt("Accounts")}>
        <AccountsStatusLine environmentId={environmentId} />
      </SettingsSection>
    );
  return (
    <AccountsContent
      environmentId={environmentId}
      snapshot={data}
      canWrite={accounts.canWrite}
      link={link}
    />
  );
}
export function AccountsPage({ link = {} }: { link?: AccountsLink }) {
  const primary = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const environmentId = scope === null ? primary : (scope.environment?.environmentId ?? null);
  const gt = useGT();
  return (
    <SettingsPageContainer>
      {environmentId ? (
        <AccountsEnvironment key={environmentId} environmentId={environmentId} link={link} />
      ) : (
        <SettingsSection title={gt("Accounts")}>
          <SettingsRow title={gt("No computer connected")} />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

/** A connector with its own sign-in or key, whatever its state; GitHub's are its identities. */
function holdsCredential(connector: ConnectorSummary): boolean {
  return connector.auth.type === "oauth" || connector.auth.type === "credential";
}
