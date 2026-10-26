import {
  AccountsError,
  type AccountId,
  type AccountTarget,
  type AccountUseAction,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { signIn } from "../signIn/engine.ts";
import { matchesAccountOrigin } from "../signIn/origin.ts";
import { AccountCookies, netscapeCookieJar } from "./cookies.ts";
import { AccountSessionFiles, credentialContents, shellQuote } from "./sessionFiles.ts";
import { accountRequest } from "./request.ts";
import { accountSessionScope } from "./scope.ts";
import { authorizePreviewProfile } from "./previewProfileAccess.ts";
import { ScientAccountsToolkit } from "./tools.ts";

const decodeCookies = Schema.decodeUnknownEffect(AccountCookies);
const encodeCookies = Schema.encodeEffect(Schema.fromJsonString(AccountCookies));

const fail = (reason: AccountsError["reason"], message: string) =>
  new AccountsError({ reason, message });
const authorize = Effect.fn("AccountsAgent.authorize")(function* (
  scope: AccountSessionScope,
  target: AccountTarget,
  action: AccountUseAction,
) {
  const accounts = yield* AccountsService;
  const decision = yield* accounts.authorize(scope, target, action);
  if (decision.decision === "denied")
    return yield* fail(
      "denied",
      "This account is unavailable to this session. Change its access in Settings → Accounts.",
    );
});
const withAccountUse = Effect.fn("AccountsAgent.use")(function* <A, E, R>(
  scope: AccountSessionScope,
  target: AccountTarget,
  action: AccountUseAction,
  operation: Effect.Effect<A, E, R>,
  succeeded: (result: A) => boolean = () => true,
) {
  const accounts = yield* AccountsService;
  yield* authorize(scope, target, action);
  return yield* operation.pipe(
    Effect.onExit((exit) =>
      accounts.recordUse({
        target,
        action,
        threadId: scope.threadId,
        ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
        outcome: exit._tag === "Success" && succeeded(exit.value) ? "ok" : "error",
      }),
    ),
  );
});
const getAccount = Effect.fn("AccountsAgent.getAccount")(function* (
  scope: AccountSessionScope,
  accountId: AccountId,
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope);
  const account = session.accounts.find((item) => item.accountId === accountId);
  if (!account || !session.agentAccess)
    return yield* fail("denied", "This account is unavailable to this session.");
  return account;
});

export const accountAgentOperations = {
  scient_accounts_list: Effect.fn("AccountsAgent.list")(function* () {
    const accounts = yield* AccountsService;
    const scope = yield* accountSessionScope();
    const invocation = yield* AgentInvocationContext;
    const broker = yield* PreviewAutomationBroker;
    const browser = invocation.capabilities.has("preview")
      ? yield* broker
          .invoke<PreviewAutomationStatus>({
            scope: invocation,
            operation: "status",
            input: {},
            updateCurrentTab: false,
          })
          .pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    const session = yield* accounts.forSession(
      scope,
      browser?.profiles?.map((profile) => profile.id),
    );
    return {
      accounts: session.agentAccess
        ? session.accounts
            .filter((account) => account.controls.access !== "off")
            .map((account) => ({
              accountId: account.accountId,
              name: account.name,
              kind: account.details.kind,
              sites: "sites" in account.details ? account.details.sites : [],
              access: account.controls.access,
              readable: account.controls.visibility === "readable",
              status: account.status,
              usage: [
                ...(account.controls.visibility === "readable"
                  ? ["scient_account_credentials"]
                  : []),
                ...(account.details.kind === "api-key" ? ["scient_account_request"] : []),
                ...(["website", "library"].includes(account.details.kind)
                  ? ["scient_account_sign_in", "scient_account_browser_session"]
                  : []),
              ],
            }))
        : [],
      profiles: session.agentAccess
        ? session.profiles
            .filter((profile) => profile.access !== "off")
            .map((profile) => ({
              profileId: profile.profileId,
              name:
                browser?.profiles?.find((item) => item.id === profile.profileId)?.name ??
                profile.source?.profileName ??
                profile.profileId,
              usage: profile.scriptSignIn ? ["scient_account_browser_session"] : ["preview_open"],
              access: profile.access,
              scriptSignIn: profile.scriptSignIn,
            }))
        : [],
    };
  }),
  scient_account_credentials: Effect.fn("AccountsAgent.credentials")(function* ({
    accountId,
  }: {
    accountId: AccountId;
  }) {
    const scope = yield* accountSessionScope();
    return yield* withAccountUse(
      scope,
      { type: "account", accountId },
      "credentials",
      Effect.gen(function* () {
        const accounts = yield* AccountsService;
        const files = yield* AccountSessionFiles;
        const account = yield* getAccount(scope, accountId);
        if (account.controls.visibility !== "readable")
          return yield* fail(
            "denied",
            "This account is hidden. The user can make it readable in Settings → Accounts.",
          );
        const fields = Object.keys(account.secrets);
        const values = yield* accounts.resolveSecrets(accountId, fields);
        if (fields.some((field) => values[field] === undefined))
          return yield* fail("unavailable", "An account value is unavailable.");
        const directory = yield* files.directory(scope.threadId);
        const content = yield* Effect.try({
          try: () => credentialContents(account, values, directory),
          catch: () =>
            fail("invalid-input", "The account cannot be represented safely in credential files."),
        });
        const paths = yield* Effect.forEach(Object.entries(content.files), ([name, content]) =>
          files.write(scope.threadId, name, content),
        );
        return { paths, usage: content.usage };
      }),
    );
  }),
  scient_account_sign_in: Effect.fn("AccountsAgent.signInTool")(function* ({
    accountId,
    tabId,
  }: {
    accountId: AccountId;
    tabId?: PreviewTabId | undefined;
  }) {
    const scope = yield* accountSessionScope();
    return yield* withAccountUse(
      scope,
      { type: "account", accountId },
      "sign-in",
      Effect.gen(function* () {
        const accounts = yield* AccountsService;
        const account = yield* getAccount(scope, accountId);
        const values = yield* accounts.resolveSecrets(accountId, ["password", "totp"]);
        return yield* signIn(scope, account, values, tabId);
      }),
      (result) => result.outcome !== "failed",
    );
  }),
  scient_account_request: Effect.fn("AccountsAgent.request")(function* (
    input: ToolInput<"scient_account_request">,
  ) {
    const scope = yield* accountSessionScope();
    const accountId = input.accountId;
    return yield* withAccountUse(
      scope,
      { type: "account", accountId },
      "request",
      Effect.gen(function* () {
        const accounts = yield* AccountsService;
        const files = yield* AccountSessionFiles;
        const account = yield* getAccount(scope, accountId);
        if (account.details.kind !== "api-key")
          return yield* fail("invalid-input", "Choose an API key account for a request.");
        const details = account.details;
        const values = yield* accounts.resolveSecrets(accountId, ["token"]);
        if (!values.token) return yield* fail("unavailable", "The account key is unavailable.");
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            accountRequest(
              input,
              details.sites,
              account.controls.permission === "read-only",
              details.auth,
              Redacted.value(values.token!),
              signal,
            ),
          catch: () => fail("denied", "The account request was refused or could not be completed."),
        });
        if (response.text && response.bytes.byteLength <= 256 * 1024)
          return { status: response.status, body: new TextDecoder().decode(response.bytes) };
        const path = yield* files.write(scope.threadId, `${accountId}-response`, response.bytes);
        return { status: response.status, path };
      }),
    );
  }),
  scient_account_browser_session: Effect.fn("AccountsAgent.browserSession")(function* (
    input: ToolInput<"scient_account_browser_session">,
  ) {
    const scope = yield* accountSessionScope();
    const invocation = yield* AgentInvocationContext;
    if (!invocation.capabilities.has("preview"))
      return yield* fail("denied", "Browser access is disabled for this session.");
    if (
      !URL.canParse(input.url) ||
      new URL(input.url).protocol !== "https:" ||
      new URL(input.url).username ||
      new URL(input.url).password
    )
      return yield* fail("invalid-input", "Choose an HTTPS site for the browser session.");
    const accounts = yield* AccountsService;
    const broker = yield* PreviewAutomationBroker;
    const files = yield* AccountSessionFiles;
    const account =
      input.accountId === undefined ? undefined : yield* getAccount(scope, input.accountId);
    if (
      account &&
      ((account.details.kind !== "website" && account.details.kind !== "library") ||
        !matchesAccountOrigin(input.url, account.details.sites))
    )
      return yield* fail("denied", "The requested site does not match this website account.");
    const profileId =
      input.profileId ??
      (account && "profileId" in account.details ? account.details.profileId : undefined);
    const invoke = <A>(
      operation: Parameters<typeof broker.invoke>[0]["operation"],
      data: unknown,
      tabId?: PreviewTabId,
    ) =>
      broker
        .invoke<A>({
          scope: invocation,
          operation,
          input: data,
          ...(tabId === undefined ? {} : { tabId }),
          updateCurrentTab: false,
        })
        .pipe(
          Effect.mapError(() => fail("unavailable", "The browser session could not be exported.")),
        );
    const status = yield* invoke<PreviewAutomationStatus>("status", {});
    const open = {
      ...(profileId === undefined ? {} : { profileId }),
      reuseExistingTab: false,
      open: false,
    };
    if (account)
      yield* authorize(scope, { type: "account", accountId: account.accountId }, "browser-session");
    const profile = yield* authorizePreviewProfile(scope, status, open, "browser-session");
    const target: AccountTarget = { type: "profile", profileId: profile.profileId };
    const operation = Effect.gen(function* () {
      const existing = status.tabs?.find(
        (tab) => tab.ownedByCaller && tab.profileId === profile.profileId,
      );
      const opened = existing
        ? { tabId: existing.tabId }
        : yield* invoke<PreviewAutomationStatus>("open", { ...open, profileId: profile.profileId });
      if (!opened.tabId)
        return yield* fail("unavailable", "No browser tab is available for this profile.");
      const raw = yield* invoke<unknown>("accountCookies", { urls: [input.url] }, opened.tabId);
      const cookies = yield* decodeCookies(raw).pipe(
        Effect.mapError(() => fail("unavailable", "The browser session could not be read.")),
      );
      const jar = yield* Effect.try({
        try: () => netscapeCookieJar(cookies),
        catch: () => fail("unsupported", "The browser session contains an unsupported cookie."),
      });
      const name = `${profile.profileId}-cookies`;
      const jarPath = yield* files.write(scope.threadId, `${name}.txt`, jar);
      const jsonPath = yield* files.write(
        scope.threadId,
        `${name}.json`,
        yield* encodeCookies(cookies).pipe(
          Effect.mapError(() => fail("unavailable", "The browser session could not be encoded.")),
        ),
      );
      return {
        paths: [jarPath, jsonPath],
        usage: `curl --cookie ${shellQuote(jarPath)} ${shellQuote(new URL(input.url).origin)}; Python: import http.cookiejar, requests; jar = http.cookiejar.MozillaCookieJar(${shellQuote(jarPath)}); jar.load(ignore_discard=True); requests.get(${shellQuote(new URL(input.url).origin)}, cookies=jar)`,
      };
    });
    return yield* operation.pipe(
      Effect.onExit((exit) =>
        Effect.all(
          [
            accounts.recordUse({
              target,
              action: "browser-session",
              threadId: scope.threadId,
              ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
              outcome: exit._tag === "Success" ? "ok" : "error",
            }),
            ...(account
              ? [
                  accounts.recordUse({
                    target: { type: "account", accountId: account.accountId },
                    action: "browser-session",
                    threadId: scope.threadId,
                    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
                    outcome: exit._tag === "Success" ? "ok" : "error",
                  }),
                ]
              : []),
          ],
          { discard: true },
        ),
      ),
    );
  }),
} satisfies Parameters<typeof ScientAccountsToolkit.toLayer>[0];
type ToolInput<K extends keyof typeof ScientAccountsToolkit.tools> = Schema.Schema.Type<
  (typeof ScientAccountsToolkit.tools)[K]["parametersSchema"]
>;
