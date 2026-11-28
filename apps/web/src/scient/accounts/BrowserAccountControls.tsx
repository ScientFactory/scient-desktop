import { msg, T, useGT } from "gt-react";
import { useSignInRecording } from "./useSignInRecording";
import { useUniversityBrowsing } from "./useUniversityBrowsing";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ACCOUNTS_PROTOCOL_1, ACCOUNTS_PROTOCOL_2, BrowserProfileId } from "@t3tools/contracts";
import type {
  AccountId,
  AccountSummary,
  AccountWriteStore,
  AccountStoresStatus,
  AccountMatchSignInResult,
  DesktopCapturedSignIn,
  DesktopLoginForm,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { KeyRoundIcon, RectangleEllipsisIcon } from "lucide-react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { Button } from "~/components/ui/button";
import { InputGroupAddon } from "~/components/ui/input-group";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { accountsState } from "./accountsState";
import { useAccountCommand, useAccounts } from "./useAccounts";
import {
  captureFollowUp,
  capturedSignInInput,
  fillableAccounts,
  matchingAccounts,
  mergeProfiles,
} from "./accountsView";
import { SignInKey } from "./SignInKey";
import { signInEvidence } from "./sessionDetection";
import { savedPasswordsLink } from "./accountsLink";
import { useLoginActions } from "./loginActions";
import { loginState, signInKeyChoices } from "./savedLogins";

import { SaveStores } from "./SaveStores";
import { autofilledTabs, filledTabRecord, signInFinished, stillShows } from "./accountAutofill";
import {
  fillStrongPassword,
  heldPasswordFor,
  keepMadePassword,
  type HeldPassword,
} from "./newPasswords";
import { ServerTabSignIn } from "./ServerTabSignIn";
import {
  forgetLocalNeverAsk,
  keepLocalNeverAsk,
  localNeverAsk,
  unsentNeverAsk,
  uploadLocalNeverAsk,
} from "./neverAsk";
import { useClientSettings } from "~/hooks/useSettings";
import { useThreadPreviewState } from "~/previewStateStore";
import { m } from "~/i18n/messages";

function SaveSignIn({
  capture,
  environmentId,
  matching,
  accounts,
  comparison,
  stores,
  anchor,
  onClose,
  serverKeeps,
}: {
  anchor: HTMLElement | null;
  capture: DesktopCapturedSignIn;
  environmentId: EnvironmentId;
  /** The server keeps "Don't ask for this site" for every client. */
  serverKeeps: boolean;
  matching: ReadonlyArray<AccountSummary>;
  /** Every saved row: the server may match a copy in another profile. */
  accounts: ReadonlyArray<AccountSummary>;
  comparison: AccountMatchSignInResult;
  stores: AccountStoresStatus;
  onClose: () => void;
}) {
  const [selectedStores, setSelectedStores] = useState<ReadonlyArray<AccountWriteStore>>([
    { type: "scient" },
  ]);
  const [busy, setBusy] = useState(false);
  // Several saved tenants this page could be: the person picks which one changed.
  const choices = (comparison.choices ?? []).flatMap((id) => {
    const account = accounts.find((item) => item.accountId === id);
    return account ? [account] : [];
  });
  const [chosen, setChosen] = useState(choices.length > 1 ? undefined : comparison.accountId);
  const save = useAccountCommand(accountsState.save, environmentId);
  const neverAsk = useAccountCommand(accountsState.neverAsk, environmentId);
  const gt = useGT();
  const origin = new URL(capture.url).origin;
  const submit = async () => {
    if (busy || !selectedStores.length) return;
    setBusy(true);
    // An update goes to the row the server matched for this capture, in whatever profile.
    const allowed =
      choices.length > 1 ? choices.map((account) => account.accountId) : [comparison.accountId];
    const target =
      comparison.result === "password-changed" && allowed.includes(chosen)
        ? accounts.find((account) => account.accountId === chosen)
        : undefined;
    if (comparison.result === "password-changed" && !target) {
      setBusy(false);
      return;
    }
    const input = target
      ? { accountId: target.accountId, name: target.name, details: target.details, secrets: {} }
      : capturedSignInInput(
          capture,
          matching.filter((account) => !account.secrets.password),
        );
    const result = await save({
      ...input,
      secrets: { password: { type: "scient", value: capture.password, saveTo: selectedStores } },
    });
    setBusy(false);
    if (result.ok) onClose();
  };
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverPopup anchor={anchor} align="end">
        <div
          className="w-72"
          role="dialog"
          aria-label={
            comparison.result === "password-changed" ? gt("Update password?") : gt("Save sign-in?")
          }
        >
          <div className="text-sm font-medium">
            {comparison.result === "password-changed"
              ? gt("Update password?")
              : gt("Save sign-in?")}
          </div>
          <div className="my-2 text-xs text-muted-foreground">
            {[new URL(origin).hostname, capture.username].filter(Boolean).join(" · ")}
          </div>
          {choices.length > 1 ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {choices.map((account) => (
                <Button
                  key={account.accountId}
                  size="xs"
                  variant={chosen === account.accountId ? "default" : "outline"}
                  aria-pressed={chosen === account.accountId}
                  onClick={() => setChosen(account.accountId)}
                >
                  {account.details.kind === "website" && account.details.loginUrl
                    ? new URL(account.details.loginUrl).pathname
                    : account.name}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="mb-3">
            <SaveStores
              kept={
                matching.find((account) => account.accountId === comparison.accountId)?.secrets
                  .password
              }
              stores={stores}
              selected={selectedStores}
              onChange={setSelectedStores}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              disabled={
                busy ||
                selectedStores.length === 0 ||
                (comparison.result === "password-changed" && chosen === undefined)
              }
              onClick={() => void submit()}
            >
              {comparison.result === "password-changed"
                ? gt("Update", { $context: "verb, saves the changed password" })
                : gt("Save", { $context: "verb, saves the sign-in" })}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (serverKeeps) void neverAsk({ add: [origin] });
                else keepLocalNeverAsk(origin);
                onClose();
                // The one place to take it back for a site with nothing saved yet.
                const id = toastManager.add({
                  type: "info",
                  title: m(msg("Won't offer to save for this site")),
                  actionProps: {
                    children: m(msg("Undo")),
                    onClick: () => {
                      toastManager.close(id);
                      if (serverKeeps) void neverAsk({ remove: origin });
                      forgetLocalNeverAsk(origin);
                    },
                  },
                });
              }}
            >
              <T>Don't ask for this site</T>
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function DesktopBrowserAccountControls({
  environmentId,
  threadRef,
  tabId,
  previewTabId,
  profileId,
  url,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  tabId: string;
  previewTabId?: string | undefined;
  profileId: string;
  url: string;
}) {
  const { data, canWrite, error, refresh } = useAccounts(environmentId);
  const gt = useGT();
  const inAttempt = (data?.attempts ?? []).some((attempt) => attempt.tabId === previewTabId);
  const [pending, setPending] = useState<{
    /** Which capture this offer answers: a later one is a new offer with its own choice. */
    generation: number;
    capture: DesktopCapturedSignIn;
    comparison: AccountMatchSignInResult;
  } | null>(null);
  useSignInRecording({
    environmentId,
    tabId,
    profileId,
    url,
    accounts: data?.accounts ?? [],
    sessionsSeen: (data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_1,
    signingIn: inAttempt,
    enabled: canWrite && pending === null,
  });
  useUniversityBrowsing({
    environmentId,
    threadRef,
    tabId: previewTabId ?? "",
    profileId,
    url,
    accounts: data?.accounts ?? [],
    enabled: canWrite && previewTabId !== undefined,
  });
  const [filledAccount, setFilledAccount] = useState<{ accountId: string; url: string } | null>(
    null,
  );
  const captureGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const currentUrl = useRef(url);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Track the tab's page for fills in flight, and clear it on unmount so a late answer never fills the page another tab now shows.
  useEffect(() => {
    currentUrl.current = url;
    return () => {
      currentUrl.current = "";
    };
  }, [url]);
  const [newPasswordForm, setNewPasswordForm] = useState<DesktopLoginForm | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Follow the desktop's report of a sign-up or change form in this tab, which lives outside React.
  useEffect(() => {
    const bridge = window.desktopBridge?.accounts;
    if (!bridge?.loginForm || !canWrite) return;
    let live = true;
    const origin = URL.parse(url)?.origin;
    // Only this page's form: a report for the page the tab left is no offer.
    const take = (form: DesktopLoginForm | null) => {
      if (live) setNewPasswordForm(form?.newPassword && form.url === origin ? form : null);
    };
    void bridge.loginForm(tabId).then(take, () => undefined);
    const stop = bridge.onLoginFormDetected?.((form) => {
      if (form.tabId === tabId) take(form);
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [tabId, url, canWrite]);
  const getValues = useAccountCommand(accountsState.fillValues, environmentId);
  const compare = useAccountCommand(accountsState.matchSignIn, environmentId);
  const neverAsk = useAccountCommand(accountsState.neverAsk, environmentId);
  const reveal = useAccountCommand(accountsState.reveal, environmentId);
  const serverKeeps = data ? (data.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2 : false;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- This browser's "Don't ask" list moves to the server that now keeps it, once.
  useEffect(() => {
    if (!serverKeeps) return;
    void uploadLocalNeverAsk(environmentId, async (origins) =>
      neverAsk({ add: origins }).then((result) => result.ok),
    );
  }, [serverKeeps, environmentId, neverAsk]);
  const signInSeen = useAccountCommand(accountsState.signInSeen, environmentId);
  const saveSignIn = useAccountCommand(accountsState.save, environmentId);
  const login = useLoginActions(environmentId);
  /** The same login worked with another password: it and its copies take it, with Undo. */
  const keepChanged = async (accountId: AccountId, capture: DesktopCapturedSignIn) => {
    const account = data?.accounts.find((row) => row.accountId === accountId);
    if (!account) return;
    const saved = await saveSignIn({
      accountId,
      name: account.name,
      details: account.details,
      secrets: { password: { type: "scient", value: capture.password } },
    });
    if (!saved.ok) return;
    void signInSeen({ accountId, outcome: "signed-in" });
    // Accounts says so with Undo (each copy gets its own earlier password back); before Accounts
    // protocol 2 there is no such Undo.
    if (!serverKeeps) toastManager.add({ type: "success", title: m(msg("Password updated")) });
  };
  /** Another username worked where a saved one was refused: it is its own login, with Undo. */
  const keepNew = async (
    capture: DesktopCapturedSignIn,
    sameSite: ReadonlyArray<AccountSummary>,
  ) => {
    const saved = await saveSignIn({
      ...capturedSignInInput(
        capture,
        sameSite.filter((account) => !account.secrets.password),
      ),
      secrets: { password: { type: "scient", value: capture.password } },
    });
    if (!saved.ok || !saved.value.account) return;
    const account = saved.value.account;
    void signInSeen({ accountId: account.accountId, outcome: "signed-in" });
    const remove = login.remove;
    const id = toastManager.add({
      type: "success",
      title: m(
        msg("Saved {username}", { username: capture.username || new URL(capture.url).hostname }),
      ),
      ...(remove
        ? {
            actionProps: {
              children: m(msg("Undo")),
              onClick: () => {
                toastManager.close(id);
                void remove([account], capture.username);
              },
            },
          }
        : {}),
    });
  };
  const holdNew = useAccountCommand(accountsState.pending, environmentId);
  /**
   * The strong password Scient made for this tab's form, sent: Accounts holds it for its login
   * (or a new one) until the site answers, the login keeping the password that works meanwhile.
   */
  const keepMade = async (made: HeldPassword, capture: DesktopCapturedSignIn) => {
    const sameSite = matchingAccounts(data?.accounts ?? [], capture.url, capture.profileId);
    const settled = await keepMadePassword(tabId, made, capture, sameSite, {
      rotate: async (accountId, withMade, pendingId) => {
        const target = accountId
          ? { accountId }
          : capturedSignInInput(
              withMade,
              sameSite.filter((account) => !account.secrets.password),
            );
        const held = await holdNew({
          type: "rotate",
          pendingId,
          origin: withMade.url,
          profileId: BrowserProfileId.make(withMade.profileId),
          username: withMade.username,
          password: withMade.password,
          ...(target.accountId ? { accountId: target.accountId } : {}),
          ...("details" in target && target.details.kind === "website"
            ? { login: { name: target.name, details: target.details } }
            : {}),
        });
        return held.ok ? held.value.pendingId : undefined;
      },
      settle: async (pendingId, outcome) =>
        (await holdNew({ type: "settle", pendingId, outcome })).ok,
    });
    // Unclear and conflicting answers come back as Accounts' own notice, with their buttons.
    // Unsent word of the submit: Accounts still holds the password from before the fill.
    if (settled === "unsaved")
      toastManager.add({
        type: "warning",
        title: m(msg("Accounts didn't hear the site's answer")),
        description: m(
          msg("The new password is kept. Accounts will ask whether the site took it."),
        ),
      });
  };
  const onCapture = useEffectEvent((capture: DesktopCapturedSignIn) => {
    if (capture.tabId !== tabId || capture.profileId !== profileId) return;
    const made = capture.newPassword
      ? heldPasswordFor(tabId, capture.url, capture.newPassword)
      : undefined;
    if (made) return void keepMade(made, capture);
    if (!capture.password) return;
    // Scient's own sign-in on this tab keeps what is typed once it is proven (`signInKeeps`).
    if (inAttempt && (data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_1) return;
    try {
      const origin = new URL(capture.url).origin;
      const never =
        data && (data.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2
          ? [...(data.neverAsk ?? []), ...unsentNeverAsk(environmentId)]
          : localNeverAsk();
      if (!origin.startsWith("https://") || never.includes(origin)) return;
      // The site's cookies as the form was sent, to tell a sign-in from a refusal afterwards.
      const cookies = () =>
        window.desktopBridge?.accounts?.cookieMetadata?.(capture.profileId, environmentId) ??
        Promise.resolve(null);
      const before = cookies().catch(() => null);
      void (async () => {
        const generation = ++captureGeneration.current;
        const result = await compare({
          origin,
          path: capture.path,
          username: capture.username,
          password: capture.password,
          profileId: capture.profileId,
        });
        if (generation !== captureGeneration.current || !result.ok) return;
        const sameSite = matchingAccounts(data?.accounts ?? [], capture.url, capture.profileId);
        const next = captureFollowUp(result.value, sameSite);
        // Without a username it is a sign-in only on a site already saved with none.
        const offer =
          next === "offer" &&
          (capture.username !== "" ||
            sameSite.some(({ details }) => details.kind === "website" && !details.username));
        setPending(offer ? { generation, capture, comparison: result.value } : null);
        if (next === "offer") return;
        // Saved only once the sign-in finished: the tab left the page it was sent from, fully
        // loaded, with no username, password or code box left.
        const finished = await signInFinished(tabId, `${origin}${capture.path}`, async () => {
          const [then, now] = await Promise.all([before, cookies().catch(() => null)]);
          return then !== null && now !== null
            ? signInEvidence(then, now, capture.url)
            : ("none" as const);
        });
        if (!finished || generation !== captureGeneration.current) return;
        // Not proven either way: the person decides with the card, nothing is saved silently.
        if (finished === "unverified") {
          if (next !== "none") setPending({ generation, capture, comparison: result.value });
          return;
        }
        const { accountId } = result.value;
        // Seen signed in, without the request's own answer: the login's status only, never
        // which of its passwords is proven (only a fill's attempt says that).
        if (next === "none" && accountId) void signInSeen({ accountId, outcome: "signed-in" });
        if (next === "update" && accountId) await keepChanged(accountId, capture);
        if (next === "save-new") await keepNew(capture, sameSite);
      })();
    } catch {
      return;
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to the desktop's sign-in captures while this toolbar can save, and drop late comparisons on cleanup.
  useEffect(() => {
    if (!canWrite) return;
    const unsubscribe = window.desktopBridge?.accounts?.onSignInCaptured((capture) =>
      onCapture(capture),
    );
    return () => {
      captureGeneration.current++;
      unsubscribe?.();
    };
  }, [canWrite]);
  const matches =
    data && window.desktopBridge?.accounts?.originBoundFill === true
      ? fillableAccounts(data.accounts, url, profileId)
      : [];
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  // A page an agent controls could read what is filled or shown, so it gets no key.
  const agentTab =
    useThreadPreviewState(threadRef).sessions[previewTabId ?? ""]?.automationOwner !== undefined;
  const navigate = useNavigate();
  const rowName = (account: (typeof matches)[number]) =>
    account.details.kind === "website" ? (account.details.username ?? account.name) : account.name;
  const profileNames = new Map(
    mergeProfiles(
      useClientSettings((settings) => settings.browserProfiles),
      data?.profiles ?? [],
    ).map((profile) => [profile.id, profile.name]),
  );
  const profileOf = (account: AccountSummary) =>
    ("profileId" in account.details ? account.details.profileId : undefined) ?? profileId;
  const autofilled = useSyncExternalStore(autofilledTabs.subscribe, () =>
    autofilledTabs.get(tabId),
  );
  const shown =
    filledAccount?.url === url ? filledAccount : autofilled?.url === url ? autofilled : null;
  const filled = shown
    ? matches.find((account) => account.accountId === shown.accountId)
    : undefined;
  // Copies of one login are one choice, filled from the copy in this tab's profile.
  const choices = signInKeyChoices(matches, profileId, filled?.accountId, data?.accounts);
  const profiles = new Set(choices.map(({ account }) => profileOf(account)));
  const profileName = (account: AccountSummary) => profileNames.get(profileOf(account));
  const fill = async (account: AccountSummary) => {
    if (!canWrite || busy || window.desktopBridge?.accounts?.originBoundFill !== true) return;
    const requestedUrl = currentUrl.current;
    setBusy(true);
    try {
      const tab = filledTabRecord(tabId, requestedUrl);
      const origin = new URL(requestedUrl).origin;
      // The document this Fill is for: values go only into it, whatever reloads meanwhile.
      const form = await window.desktopBridge?.accounts?.loginForm?.(tabId).catch(() => null);
      if (form === null || (form && form.url !== origin)) {
        setBusy(false);
        toastManager.add({ type: "error", title: m(msg("No sign-in form found")) });
        return;
      }
      const result = await getValues({
        accountId: account.accountId,
        origin,
        ...(tab ? { tab } : {}),
      });
      if (
        result.ok &&
        currentUrl.current === requestedUrl &&
        (!form || (await stillShows(tabId, form.documentId, origin)))
      ) {
        const filled = await window.desktopBridge?.accounts?.fill({
          tabId,
          expectedOrigin: new URL(requestedUrl).origin,
          ...(form ? { documentId: form.documentId } : {}),
          ...(result.value.username !== undefined ? { username: result.value.username } : {}),
          ...(result.value.password !== undefined ? { password: result.value.password } : {}),
          ...(result.value.otp !== undefined ? { otp: result.value.otp } : {}),
        });
        if (filled) setFilledAccount({ accountId: account.accountId, url: requestedUrl });
        else toastManager.add({ type: "error", title: m(msg("No sign-in form found")) });
      }
    } catch {
      toastManager.add({ type: "error", title: m(msg("Could not fill sign-in")) });
    }
    setBusy(false);
  };
  if (!data && error)
    return (
      <InputGroupAddon align="inline-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Couldn't load saved sign-ins. Retry")}
                onClick={refresh}
              />
            }
          >
            <KeyRoundIcon />
          </TooltipTrigger>
          <TooltipPopup>
            <T>Couldn't load saved sign-ins. Retry</T>
          </TooltipPopup>
        </Tooltip>
      </InputGroupAddon>
    );
  // While Accounts loads, a still key in its place: which sites have sign-ins isn't known yet.
  if (!data && !error)
    return (
      <InputGroupAddon align="inline-end">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled
          aria-label={gt("Loading saved sign-ins")}
        >
          <KeyRoundIcon />
        </Button>
      </InputGroupAddon>
    );
  if (data && !canWrite && matches.length > 0 && !agentTab)
    return (
      <InputGroupAddon align="inline-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Read only on this device")}
              />
            }
          >
            <KeyRoundIcon />
          </TooltipTrigger>
          <TooltipPopup>
            <T>Read only on this device</T>
          </TooltipPopup>
        </Tooltip>
      </InputGroupAddon>
    );
  if (!data || !canWrite) return null;
  return (
    <>
      {/* A made password needs a server that holds it from before its fill (`reserve`). */}
      {newPasswordForm && !agentTab && data.pendingFeatures?.includes("reserve") ? (
        <InputGroupAddon align="inline-end">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={gt("Fill a strong password")}
                  onClick={() =>
                    void fillStrongPassword(
                      appAtomRegistry,
                      environmentId,
                      newPasswordForm,
                      data?.accounts.find(
                        (row) =>
                          row.accountId ===
                          (filled?.accountId ??
                            (matches.length === 1 ? matches[0]!.accountId : undefined)),
                      ),
                    ).then((done) => {
                      if (!done)
                        toastManager.add({
                          type: "error",
                          title: m(msg("No password form found")),
                        });
                    })
                  }
                />
              }
            >
              <RectangleEllipsisIcon />
            </TooltipTrigger>
            <TooltipPopup>
              <T>Fill a strong password</T>
            </TooltipPopup>
          </Tooltip>
        </InputGroupAddon>
      ) : null}
      {matches.length > 0 && !agentTab ? (
        <InputGroupAddon align="inline-end">
          <span ref={setAnchor} className="flex">
            <SignInKey
              site={new URL(url).hostname}
              rows={choices.map(({ account, copies }) => ({
                accountId: account.accountId,
                username:
                  account.details.kind === "website" ? (account.details.username ?? "") : "",
                profile: profiles.size > 1 ? profileName(account) : undefined,
                ...loginState(copies),
              }))}
              filledId={filled?.accountId}
              busy={busy}
              onFill={(accountId) => {
                const account = matches.find((match) => match.accountId === accountId);
                if (account) void fill(account);
              }}
              onReveal={async (accountId) => {
                const account = matches.find((match) => match.accountId === accountId);
                if (!account) return undefined;
                // Show is the person's own Reveal; Fill without a page is only an older server's.
                if ((data.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2) {
                  const shown = await reveal({ accountId: account.accountId, field: "password" });
                  return shown.ok ? shown.value.value : undefined;
                }
                const result = await getValues({
                  accountId: account.accountId,
                  origin: new URL(url).origin,
                });
                return result.ok ? result.value.password : undefined;
              }}
              onCopy={(accountId) => void login.copy(accountId)}
              onEditRow={login.edit}
              onRemove={
                login.remove &&
                ((accountId) => {
                  // The whole login, every copy, with one Undo, as Saved passwords removes it.
                  const choice = choices.find(({ account }) => account.accountId === accountId);
                  if (choice) void login.remove?.(choice.copies, rowName(choice.account));
                })
              }
              onEdit={() => void navigate(savedPasswordsLink(environmentId, url))}
            />
          </span>
        </InputGroupAddon>
      ) : (
        <span ref={setAnchor} className="flex" />
      )}
      {pending ? (
        <SaveSignIn
          key={pending.generation}
          capture={pending.capture}
          comparison={pending.comparison}
          stores={data.stores}
          environmentId={environmentId}
          matching={matchingAccounts(data.accounts, pending.capture.url, profileId)}
          accounts={data.accounts}
          serverKeeps={(data.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL_2}
          anchor={anchor}
          onClose={() => setPending(null)}
        />
      ) : null}
    </>
  );
}

export function BrowserAccountControls(props: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  tabId: string;
  previewTabId?: string;
  profileId: string;
  url: string;
  /** A tab the server runs: the server signs in on it, and nothing is filled here. */
  serverTab?: boolean;
}) {
  if (props.serverTab)
    return props.previewTabId ? (
      <ServerTabSignIn {...props} previewTabId={props.previewTabId} />
    ) : null;
  return window.desktopBridge?.accounts ? (
    <DesktopBrowserAccountControls
      key={`${props.environmentId}:${props.tabId}:${props.profileId}`}
      {...props}
    />
  ) : null;
}
