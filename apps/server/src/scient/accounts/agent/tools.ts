import { AccountsService } from "../AccountsService.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AccountSessionFiles } from "./sessionFiles.ts";
import {
  AccountId,
  AccountSignInOutcome,
  AccountsError,
  BrowserProfileId,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
      "List accounts and browser profiles for this session: how each may be used, and which the user turned off (tell the user; they can allow it in Settings → Accounts). Never returns values. If a page needs sign-in or access, use scient_account_find_profile.",
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
      "Write a readable account's credentials to private session files. Returns paths and a shell usage hint. Hidden accounts require a visibility change in Settings → Accounts.",
    parameters: Schema.Struct({ accountId: AccountId }),
    success: ResultFiles,
  }),
  "credentials",
  "Prepare account credentials",
);
const signIn = metadata(
  Tool.make("scient_account_sign_in", {
    ...common,
    description:
      "Sign in with a website or library account on your browser tab, with stored two-factor codes. Returns signed-in, password-rejected or code-rejected (never retried), needs-user, or failed. Waits up to 3 minutes while the user does a CAPTCHA, passkey or approval in the browser.",
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
export const ScientAccountsToolkit = Toolkit.make(
  list,
  credentials,
  signIn,
  request,
  browserSession,
  findProfile,
);
