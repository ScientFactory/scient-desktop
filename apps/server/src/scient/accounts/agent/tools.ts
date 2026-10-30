import { AccountsService } from "../AccountsService.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AccountSessionFiles } from "./sessionFiles.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../../mcp/OrchestratorMcpService.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import {
  AccountId,
  AccountSignInOutcome,
  AccountSite,
  AccountSummary,
  AccountsError,
  BrowserProfileId,
  EnvironmentVariableName,
  PreviewTabId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { WorkspaceBindingResolver } from "../../projectScope/WorkspaceBindingResolver.ts";
import { Tool, Toolkit } from "effect/ai";
import { ScientOperation, type OperationMetadata } from "../../../mcp/ScientOperationTool.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";

import { ProfileResult } from "./profileClassification.ts";

const ResultFiles = Schema.Struct({ paths: Schema.Array(Schema.String), usage: Schema.String });
const accountOperation = (id: string): OperationMetadata => ({
  id: `accounts.${id}`,
  family: "accounts",
  scope: "thread",
  requiredCapabilities: ["accounts"],
  approval: "session-grant",
  documentation: "docs/internals/scient-accounts.md",
});
const metadata = <T extends Tool.Any>(tool: T, id: string, title: string, readOnly = false) =>
  tool
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, readOnly)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true)
    .annotate(ScientOperation, accountOperation(id)) as T;
const common = {
  failure: AccountsError,
  dependencies: [
    AgentInvocationContext,
    AccountsService,
    ProjectionStoreV2,
    PreviewAutomationBroker,
    AccountSessionFiles,
  ],
};
const list = metadata(
  Tool.make("scient_accounts_list", {
    ...common,
    description:
      "List accounts and browser profiles for this session: how each may be used, and which the user turned off (tell the user; they can allow it in Settings → Accounts & secrets). Never returns values. preview_open signs in by itself with Allowed saved sign-ins; read its accountsNote.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({
      accounts: Schema.Array(
        Schema.Struct({
          accountId: AccountId,
          name: Schema.String,
          kind: Schema.String,
          sites: Schema.Array(Schema.String),
          access: Schema.String,
          readable: Schema.Boolean,
          usage: Schema.Array(Schema.String),
          status: Schema.String,
        }),
      ),
      profiles: Schema.Array(
        Schema.Struct({
          profileId: BrowserProfileId,
          name: Schema.String,
          email: Schema.optional(Schema.String),
          usage: Schema.Array(Schema.String),
          access: Schema.String,
          scriptSignIn: Schema.Boolean,
        }),
      ),
    }),
  }),
  "list",
  "List available accounts",
  true,
);
const credentials = metadata(
  Tool.make("scient_account_credentials", {
    ...common,
    description:
      "Write a readable account's credentials to private session files. Returns paths and a shell usage hint. Hidden accounts require a visibility change in Settings → Accounts & secrets.",
    parameters: Schema.Struct({ accountId: AccountId }),
    success: ResultFiles,
  }),
  "credentials",
  "Prepare account credentials",
);
const signIn = metadata(
  Tool.make("scient_account_sign_in", {
    ...common,
    dependencies: [
      ...common.dependencies,
      McpInvocationContext,
      OrchestratorMcpService,
      SecretRequests,
    ],
    description:
      "Sign in with a website or library account on your browser tab, with stored two-factor codes. Returns signed-in, password-rejected or code-rejected (never retried), limited (the site is limiting automation; wait), needs-user, or failed. Waits up to 3 minutes while the user does a CAPTCHA, passkey or approval in the browser.",
    parameters: Schema.Struct({ accountId: AccountId, tabId: Schema.optional(PreviewTabId) }),
    success: Schema.Struct({
      outcome: AccountSignInOutcome,
      message: Schema.optional(Schema.String),
      tabId: Schema.optional(PreviewTabId),
    }),
  }),
  "sign-in",
  "Sign in to an account",
);
const request = metadata(
  Tool.make("scient_account_request", {
    ...common,
    description:
      "Make an HTTPS request to an API account's sites using its hidden key. Read-only accounts permit GET and HEAD. Responses redact credentials; large or binary bodies go to a session file.",
    parameters: Schema.Struct({
      accountId: AccountId,
      method: Schema.String.check(Schema.isPattern(/^[A-Za-z]+$/)),
      url: Schema.String.check(Schema.isMaxLength(4096)),
      headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      body: Schema.optional(Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024))),
    }),
    success: Schema.Struct({
      status: Schema.Int,
      body: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
      note: Schema.optional(Schema.String),
    }),
  }),
  "request",
  "Request with an account",
);
const browserSession = metadata(
  Tool.make("scient_account_browser_session", {
    ...common,
    description:
      "Export one site's browser cookies to private Netscape and JSON session files for curl or requests. Choose a profile or website account; requires the profile's script sign-ins permission.",
    parameters: Schema.Struct({
      accountId: Schema.optional(AccountId),
      profileId: Schema.optional(BrowserProfileId),
      url: Schema.String.check(Schema.isMaxLength(4096)),
    }).check(
      Schema.makeFilter(
        (input) =>
          (input.accountId === undefined) !== (input.profileId === undefined) ||
          "Choose exactly one account or profile.",
      ),
    ),
    success: ResultFiles,
  }),
  "browser-session",
  "Prepare a browser session",
);
const findProfile = metadata(
  Tool.make("scient_account_find_profile", {
    ...common,
    description:
      "When a page asks to sign in or says you need access, find an Allowed browser profile that opens it. Then continue with preview_open in the best profile. Skips profiles requiring approval.",
    parameters: Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(2048)) }),
    success: Schema.Struct({
      profiles: Schema.Array(
        Schema.Struct({
          profileId: BrowserProfileId,
          name: Schema.String,
          email: Schema.optional(Schema.String),
          result: ProfileResult,
        }),
      ),
      best: Schema.optional(BrowserProfileId),
      skipped: Schema.optional(Schema.Array(Schema.String)),
    }),
  }),
  "find-profile",
  "Find a browser profile for a page",
);
const add = metadata(
  Tool.make("scient_account_add", {
    failure: AccountsError,
    dependencies: [
      ...common.dependencies,
      McpInvocationContext,
      OrchestratorMcpService,
      SecretRequests,
    ],
    description:
      "Ask the user, in a private card, for an API key or token to keep in Accounts, and wait. It stays out of chat. Returns its accountId and how to use it. A matching account is returned instead, or reported as turned off.",
    parameters: Schema.Struct({
      name: AccountSummary.fields.name.annotate({ description: "The service, e.g. OpenAI." }),
      reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
        description: "What it is for and where to get it.",
      }),
      envName: Schema.optional(EnvironmentVariableName).annotate({
        description: "Variable for commands, e.g. OPENAI_API_KEY.",
      }),
      sites: Schema.optional(Schema.Array(AccountSite).check(Schema.isMaxLength(16))).annotate({
        description: "API hosts the key may be sent to, e.g. api.openai.com.",
      }),
      header: Schema.optional(TrimmedNonEmptyString).annotate({
        description: "Header name when the API doesn't use Authorization: Bearer.",
      }),
      accountId: Schema.optional(AccountId).annotate({
        description: "Replace this account's key when it is wrong or expired.",
      }),
      placeholder: Schema.optional(TrimmedNonEmptyString),
    }),
    success: Schema.Union([
      Schema.Struct({
        status: Schema.Literals(["saved", "exists"]),
        accountId: AccountId,
        usage: Schema.Array(Schema.String),
      }),
      Schema.Struct({
        status: Schema.Literals(["turned_off", "linked"]).annotate({
          description:
            "turned_off: the user turned this account off. linked: its key lives in 1Password or Keychain; the user updates it there.",
        }),
        accountId: AccountId,
        name: Schema.String,
      }),
      Schema.Struct({ status: Schema.Literals(["declined", "cancelled", "timed_out"]) }),
      Schema.Struct({ status: Schema.Literal("unavailable"), message: Schema.String }),
    ]),
  }),
  "add",
  "Add an account key",
);
const paperGet = metadata(
  Tool.make("scient_paper_get", {
    failure: AccountsError,
    dependencies: [
      ...common.dependencies,
      FileSystem.FileSystem,
      Path.Path,
      WorkspaceBindingResolver,
    ],
    description:
      "Get a paper's PDF by DOI or link and save it in the project: a free legal copy first, else through the user's library access in the browser, one paper at a time. Returns its path.",
    parameters: Schema.Struct({
      doi: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
      url: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
    }),
    success: Schema.Union([
      Schema.Struct({
        status: Schema.Literal("saved"),
        path: Schema.String,
        route: Schema.Literals(["open-access", "library"]),
        published: Schema.Boolean.annotate({
          description: "False for an accepted manuscript or preprint.",
        }),
        title: Schema.optional(Schema.String),
        doi: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        status: Schema.Literals(["not-found", "no-access", "needs-sign-in", "limit"]),
        message: Schema.String,
        landingUrl: Schema.optional(Schema.String),
      }),
    ]),
  }),
  "paper-get",
  "Get a paper's PDF",
);
export const ScientAccountsToolkit = Toolkit.make(
  list,
  credentials,
  signIn,
  request,
  browserSession,
  findProfile,
  add,
  paperGet,
);
