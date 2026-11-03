import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountId,
  type AccountSummary,
  type EnvironmentId,
  type Institution,
  type ThreadId,
} from "@t3tools/contracts";
import { universitiesOf } from "@t3tools/shared/scientPaperLinks";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, GraduationCapIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useRightPanelStore } from "~/rightPanelStore";
import { libraryLinkTemplate, signedIntoUniversity } from "./accountsView";
import { accountsState } from "./accountsState";
import { SiteFavicon } from "./AccountLogo";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { useScratchThread } from "./useScratchThread";

const SEARCH_DELAY_MS = 300;
const HIDDEN_KEY = "scient:university-row-hidden";

/** The domain of a university address among saved sign-ins. Only a domain is ever searched. */
function universityDomain(accounts: ReadonlyArray<AccountSummary>) {
  for (const { details } of accounts) {
    if (details.kind !== "website") continue;
    const domain = details.username?.split("@")[1]?.toLowerCase();
    if (domain && /\.(?:edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/.test(domain)) return domain;
  }
  return undefined;
}

export function UniversityIcon({ site, className }: { site: string; className?: string }) {
  return (
    <SiteFavicon
      site={site}
      className={className ?? "size-7"}
      fallback={<GraduationCapIcon className="size-4 text-muted-foreground" />}
    />
  );
}

/** Signing in to a university from anywhere: beside the conversation, or in a new one. */
export function useUniversitySignIn(environmentId: EnvironmentId) {
  const signIn = useAccountCommand(accountsState.universitySignIn, environmentId);
  const scratchThread = useScratchThread(environmentId);
  return async (accountId: AccountId, threadId?: ThreadId) => {
    const thread = threadId ? scopeThreadRef(environmentId, threadId) : await scratchThread();
    if (!thread) return;
    if (!threadId) useRightPanelStore.getState().requestMaximize(thread);
    const started = await signIn({ accountId, threadId: thread.threadId });
    if (started.ok) useRightPanelStore.getState().openBrowser(thread, started.value.tabId);
  };
}

/**
 * Finds the user's university and goes straight to its sign-in. A university that isn't listed, or
 * only gives its people a library link, connects by that link.
 */
export function UniversityPicker({
  environmentId,
  threadId,
  autoFocus = false,
  onChosen,
}: {
  environmentId: EnvironmentId;
  /** The conversation the sign-in opens beside. */
  threadId?: ThreadId;
  autoFocus?: boolean;
  onChosen?: () => void;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  const search = useAccountCommand(accountsState.searchUniversities, environmentId);
  const save = useAccountCommand(accountsState.save, environmentId);
  const startSignIn = useUniversitySignIn(environmentId);
  const profileId =
    useClientSettings((settings) => settings.browserDefaultProfileId) ?? DEFAULT_BROWSER_PROFILE_ID;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ReadonlyArray<Institution>>([]);
  const [showLink, setShowLink] = useState(false);
  const [link, setLink] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchId = useRef(0);

  const find = (text: string) => {
    setQuery(text);
    clearTimeout(searchTimer.current);
    const asked = (searchId.current += 1);
    if (text.trim().length < 2) return setFound([]);
    searchTimer.current = setTimeout(() => {
      void search({ query: text.trim() }).then((result) => {
        if (result.ok && asked === searchId.current) setFound(result.value);
      });
    }, SEARCH_DELAY_MS);
  };

  const choose = async (university: Institution) => {
    const known = universitiesOf(data?.accounts ?? []).find(
      ({ details }) =>
        details.kind === "website" && details.institution?.entityId === university.entityId,
    );
    const saved = known
      ? undefined
      : await save({
          name: university.name,
          details: {
            kind: "website",
            sites: [university.domain],
            profileId,
            institution: university,
          },
          secrets: {},
        });
    const accountId = known?.accountId ?? (saved?.ok ? saved.value.accountId : undefined);
    if (!accountId) return;
    onChosen?.();
    await startSignIn(accountId, threadId);
  };

  const addLink = async () => {
    const pasted = libraryLinkTemplate(link);
    const proxyUrl = pasted.includes("{url}")
      ? pasted
      : `${pasted}${pasted.includes("?") ? "&" : "?"}url={url}`;
    if (!URL.canParse(pasted)) return;
    const { hostname } = new URL(pasted);
    const saved = await save({
      name: hostname,
      details: { kind: "website", sites: [hostname], profileId, proxyUrl },
      secrets: {},
    });
    if (!saved.ok) return;
    onChosen?.();
    await startSignIn(saved.value.accountId, threadId);
  };

  return (
    <div className="grid gap-1.5">
      <Input
        autoFocus={autoFocus}
        type="search"
        aria-label="Find your university"
        placeholder="University name or email domain"
        disabled={!canWrite}
        value={query}
        onChange={(event) => find(event.target.value)}
        onFocus={() => {
          const guess = universityDomain(data?.accounts ?? []);
          if (!query && guess) find(guess);
        }}
      />
      {found.map((university) => (
        <button
          key={university.entityId}
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          onClick={() => void choose(university)}
        >
          <UniversityIcon site={university.domain} />
          <span className="min-w-0">
            <span className="block truncate text-sm">{university.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {university.domain}
            </span>
          </span>
        </button>
      ))}
      {showLink ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void addLink();
          }}
        >
          <Input
            autoFocus
            type="url"
            aria-label="Your library's link"
            placeholder="Paste a link from your library's website"
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
        </form>
      ) : (
        <Button
          size="xs"
          variant="ghost-muted"
          className="justify-self-start"
          onClick={() => setShowLink(true)}
        >
          My university isn't listed
        </Button>
      )}
    </div>
  );
}

/** The first row of Sources until a university is connected; it opens where it stands. */
export function UniversityRow({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const { data } = useAccounts(environmentId);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === "true");
  if (!data || hidden || universitiesOf(data.accounts).length > 0) return null;
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <GraduationCapIcon className="size-4 text-muted-foreground" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium">Connect your university</span>
            <span className="block text-xs text-muted-foreground">
              Sign in once to your library account
            </span>
          </span>
        </button>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Hide"
          onClick={() => {
            localStorage.setItem(HIDDEN_KEY, "true");
            setHidden(true);
          }}
        >
          <XIcon />
        </Button>
      </div>
      {open ? (
        <div className="mt-1 px-1 pb-1">
          <UniversityPicker
            environmentId={environmentId}
            threadId={threadId}
            autoFocus
            onChosen={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The university's crest beside the Sources title, with a dot when it needs a sign-in. */
/** Long enough that opening the card again soon doesn't ask again. */
const RECHECK_AFTER_MS = 2 * 60 * 1000;

/**
 * The university beside the Sources title, answering one question: can Scient get papers through
 * it right now. Opening it asks again, so its status needs no button; Sign in shows only when it
 * is needed.
 */
export function UniversityCrest({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  const startSignIn = useStableCallback(useUniversitySignIn(environmentId));
  const check = useAccountCommand(accountsState.check, environmentId);
  const navigate = useNavigate();
  const [checking, setChecking] = useState<ReadonlySet<AccountId>>(new Set());
  const [signingIn, setSigningIn] = useState<ReadonlySet<AccountId>>(new Set());
  const universities = universitiesOf(data?.accounts ?? []);
  const askAgain = useStableCallback((open: boolean) => {
    if (!open || !canWrite) return;
    for (const account of universities) {
      const last = account.signIn ? Date.parse(account.signIn.at) : 0;
      if (checking.has(account.accountId) || Date.now() - last < RECHECK_AFTER_MS) continue;
      setChecking((current) => new Set(current).add(account.accountId));
      void check({ accountId: account.accountId }).finally(() =>
        setChecking((current) => {
          const next = new Set(current);
          next.delete(account.accountId);
          return next;
        }),
      );
    }
  });
  const first = universities[0];
  if (!first) return null;
  const domainOf = (account: AccountSummary) =>
    account.details.kind === "website"
      ? (account.details.institution?.domain ?? account.details.sites[0] ?? "")
      : "";
  const waiting = universities.some((account) => !signedIntoUniversity(account));
  const signIn = (accountId: AccountId) => {
    setSigningIn((current) => new Set(current).add(accountId));
    void startSignIn(accountId, threadId);
  };
  return (
    <Menu onOpenChange={askAgain}>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            aria-label={`University: ${first.name}`}
            className="relative"
          />
        }
      >
        <UniversityIcon site={domainOf(first)} className="size-5" />
        {waiting ? (
          <span aria-hidden className="absolute top-1 right-5 size-1.5 rounded-full bg-amber-500" />
        ) : null}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="max-w-72 min-w-56">
        {universities.map((account) => {
          const signedIn = signedIntoUniversity(account);
          const underWay = !signedIn && signingIn.has(account.accountId);
          const status = signedIn
            ? "Signed in"
            : underWay
              ? "Signing in…"
              : checking.has(account.accountId)
                ? "Checking…"
                : "Sign in needed";
          return (
            <div key={account.accountId}>
              <div className="px-2 py-1.5">
                <div className="truncate text-sm">{account.name}</div>
                <div className="text-xs text-muted-foreground">{status}</div>
              </div>
              {signedIn ? null : (
                <MenuItem disabled={!canWrite} onClick={() => signIn(account.accountId)}>
                  Sign in
                </MenuItem>
              )}
            </div>
          );
        })}
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/accounts" })}>
          Accounts & secrets
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
