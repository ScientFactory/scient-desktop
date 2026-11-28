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
  PaperAsked,
  PaperItem,
  PaperItemState,
  PaperVersion,
  PreviewTabId,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { WorkspaceBindingResolver } from "../../projectScope/WorkspaceBindingResolver.ts";
import { Tool, Toolkit } from "effect/ai";
import { ScientOperation, type OperationDefinition } from "../../../mcp/ScientOperationTool.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";

import { AGENT_CONNECTOR_STATUSES } from "../../extensions/connectors/agentStatus.ts";
import { ProfileResult } from "./profileClassification.ts";

const ResultFiles = Schema.Struct({ paths: Schema.Array(Schema.String), usage: Schema.String });
const accountOperation = (id: string): OperationDefinition => ({
  id: `accounts.${id}`,
  scope: "thread",
  requiredCapabilities: ["accounts"],
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
      "List accounts and browser profiles for this session: how each may be used, its sign-in state and reason, when its password last worked, and whether Scient holds automatic sign-in. Using an Off one shows the user a card to turn it on. Never returns values. preview_open signs in by itself with Allowed saved sign-ins; read its accountsNote.",
    parameters: Tool.EmptyParams,
    success: Schema.Struct({
      accounts: Schema.Array(
        Schema.Struct({
          accountId: AccountId,
          name: Schema.String,
          kind: Schema.String,
          sites: Schema.Array(Schema.String),
          username: Schema.optional(Schema.String),
          access: Schema.String,
          readable: Schema.Boolean,
          usage: Schema.Array(Schema.String),
          status: Schema.String,
          signIn: Schema.optional(Schema.String),
          reason: Schema.optional(Schema.String),
          lastWorked: Schema.optional(Schema.String),
          profileId: Schema.optional(Schema.String),
          /** Scient won't sign in by itself until the person does or the saved value changes. */
          held: Schema.optional(Schema.Boolean),
          /** A 2FA key is stored; Scient types its codes. */
          twoFactor: Schema.optional(Schema.Boolean),
          /** How many unused backup codes are stored; only the person's tap uses one. */
          backupCodes: Schema.optional(Schema.Int),
          /** Something wrong with the saved password; the person's row offers Fix. */
          passwordHealth: Schema.optional(Schema.Literals(["leaked", "reused", "weak"])),
          /** What applies in this project and profile, and why when it isn't Allowed. */
          effective: Schema.optional(Schema.Literals(["allowed", "ask", "off"])),
          why: Schema.optional(Schema.String),
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
      /** The person's "Renew sign-ins automatically"; off, renewal only looks. */
      renewAutomatically: Schema.Boolean,
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
      "Write a readable account's credentials to private session files. Returns paths and a shell usage hint. A hidden account (website passwords by default) is used through sign_in, fill and request instead.",
    parameters: Schema.Struct({ accountId: AccountId }),
    success: ResultFiles,
  }),
  "credentials",
  "Prepare account credentials",
);
/** A one-time code as sites send it: digits, sometimes letters or a dash. */
const SignInCode = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{4,12}$/));
const signIn = metadata(
  Tool.make("scient_account_sign_in", {
    ...common,
    // A sign-in that works releases the papers waiting for it.
    dependencies: [
      ...common.dependencies,
      FileSystem.FileSystem,
      Path.Path,
      McpInvocationContext,
      OrchestratorMcpService,
      SecretRequests,
    ],
    description:
      "Sign in with a website or library account on your browser tab, with stored two-factor codes. Returns signed-in, password-rejected or code-rejected (held until the user signs in or saves a new one), limited (the site is limiting automation; wait), needs-user, or failed. When the user asks to be signed in, call this: it shows them the sign-in card and waits while they do a CAPTCHA, passkey or approval. Scient reads texted and mailed codes on its Mac itself. When the result has `code`, and you can read the user's mail, find a code from those domains sent after that time and call again with it as `code`; never ask the user for it.",
    parameters: Schema.Struct({
      accountId: AccountId,
      tabId: Schema.optional(PreviewTabId),
      code: Schema.optional(SignInCode),
    }),
    success: Schema.Struct({
      outcome: AccountSignInOutcome,
      message: Schema.optional(Schema.String),
      tabId: Schema.optional(PreviewTabId),
      code: Schema.optional(
        Schema.Struct({ from: Schema.Array(Schema.String), sentAfter: Schema.String }),
      ),
    }),
  }),
  "sign-in",
  "Sign in to an account",
);
const fill = metadata(
  Tool.make("scient_account_fill", {
    ...common,
    description:
      "Type one saved field of a website or library account into your own browser tab, on a page of the account's sites, without showing you the value. Use it when scient_account_sign_in returns needs-user or failed on a page you can read: find the step yourself, fill the field, then press the page's button. With field code, pass `code` to type a code you read from the user's mail instead of the saved 2FA key's. If the site refuses a password, ask for the new one with scient_account_add (secret: password).",
    parameters: Schema.Struct({
      accountId: AccountId,
      field: Schema.Literals(["username", "password", "code"]),
      tabId: Schema.optional(PreviewTabId),
      selector: Schema.optional(Schema.String),
      code: Schema.optional(SignInCode),
    }),
    success: Schema.Struct({ filled: Schema.Boolean, message: Schema.optional(Schema.String) }),
  }),
  "fill",
  "Fill a saved sign-in field",
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
      "Export one site's browser cookies to private Netscape and JSON session files for curl or requests. Pass exactly one of accountId (a website account) or profileId; requires the profile's script sign-ins permission.",
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
const check = metadata(
  Tool.make("scient_account_check", {
    ...common,
    description:
      "Check an account without changing it: a website in a hidden tab in its profile, never signing in; a key or other account by reading its saved value. Returns its state and reason, when its password last worked, its profile and whether Scient holds automatic sign-in.",
    parameters: Schema.Struct({ accountId: AccountId }),
    success: Schema.Struct({
      state: Schema.String,
      reason: Schema.optional(Schema.String),
      lastWorked: Schema.optional(Schema.String),
      profileId: Schema.optional(Schema.String),
      held: Schema.optional(Schema.Boolean),
    }),
  }),
  "check",
  "Check an account",
  true,
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
      FileSystem.FileSystem,
      Path.Path,
      McpInvocationContext,
      OrchestratorMcpService,
      SecretRequests,
    ],
    description:
      "Keep a secret in Accounts. api-key: always a new account, even beside a saved key for the service; pass accountId only to replace that one. With value (a key the user gave in this chat or you created), it is saved as is; without, a private card asks the user and you never see it. website or university: with secret, its password or 2FA key (also to replace one by accountId); without, they sign in on its own page. Use this, not request_secret, for keys and passwords. Returns the account, how to use it, and open: give the user that link.",
    parameters: Schema.Struct({
      kind: Schema.optional(Schema.Literals(["api-key", "website", "university"])).annotate({
        description: "api-key (default), website, or university.",
      }),
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
        description: "Replace this account's key, password or 2FA key when it is wrong or expired.",
      }),
      secret: Schema.optional(Schema.Literals(["password", "totp"])).annotate({
        description: "website or university: ask for its password or 2FA key in the card.",
      }),
      placeholder: Schema.optional(TrimmedNonEmptyString),
      value: Schema.optional(Schema.String.check(Schema.isMaxLength(65_536))).annotate({
        description: "api-key: the key, when the user gave it in this chat or you created it.",
      }),
      site: Schema.optional(AccountSite).annotate({
        description: "website: the site to sign in to, e.g. github.com.",
      }),
      loginUrl: Schema.optional(
        TrimmedNonEmptyString.check(Schema.isPattern(/^https:\/\//)),
      ).annotate({ description: "website: its sign-in page, when not on the site's home page." }),
      username: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
        description: "website: who signs in, when the user has several there.",
      }),
      institution: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))).annotate({
        description: "university: its name or email domain, e.g. huji.ac.il.",
      }),
    }),
    success: Schema.Union([
      Schema.Struct({
        status: Schema.Literals(["saved", "exists", "signed-in"]),
        accountId: AccountId,
        usage: Schema.Array(Schema.String),
        open: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        status: Schema.Literals(["turned_off", "linked"]).annotate({
          description:
            "turned_off: the user turned this account off. linked: its key lives in 1Password or Keychain; the user updates it there.",
        }),
        accountId: AccountId,
        name: Schema.String,
      }),
      Schema.Struct({
        status: Schema.Literals(["declined", "cancelled", "timed_out"]),
        note: Schema.String,
      }),
      Schema.Struct({ status: Schema.Literal("unavailable"), message: Schema.String }),
      Schema.Struct({
        status: Schema.Literal("choose").annotate({
          description: "Several universities match: call again with the right one's domain.",
        }),
        universities: Schema.Array(Schema.Struct({ name: Schema.String, domain: Schema.String })),
      }),
    ]),
  }),
  "add",
  "Add an account key",
);
const connectorSetup = metadata(
  Tool.make("scient_connector_setup", {
    failure: AccountsError,
    dependencies: [
      ...common.dependencies,
      McpInvocationContext,
      OrchestratorMcpService,
      SecretRequests,
    ],
    description:
      "When a connector says it needs setup. A local one: saves settings you asked the user in chat, and asks for each missing key in a private card (or links their saved key); then call its tool again. replaceKeys asks again for a key the program rejected. A hosted one: says what it needs and who gives it.",
    parameters: Schema.Struct({
      connector: TrimmedNonEmptyString.annotate({ description: "Its MCP server name." }),
      settings: Schema.optional(
        Schema.Record(
          TrimmedNonEmptyString,
          Schema.Union([
            Schema.String.check(Schema.isMaxLength(4096)),
            Schema.Number,
            Schema.Boolean,
          ]),
        ),
      ).annotate({ description: "Plain answers by setting key." }),
      replaceKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      signIn: Schema.optional(TrimmedNonEmptyString).annotate({
        description: "Which Accounts sign-in to use for its site.",
      }),
    }),
    success: Schema.Struct({
      status: Schema.Literals(["ready", "needs"]),
      missing: Schema.Array(Schema.String),
      message: Schema.String,
    }),
  }),
  "connector-setup",
  "Set up a connector",
);
const connectorDependencies = [
  ...common.dependencies,
  McpInvocationContext,
  WorkspaceBindingResolver,
];
const ConnectorName = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const FolderPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096)).annotate({
  description: "Full path, or relative to this chat's folder.",
});
const ConnectorStatus = Schema.Literals(AGENT_CONNECTOR_STATUSES);
const connectorList = metadata(
  Tool.make("scient_connector_list", {
    failure: AccountsError,
    dependencies: common.dependencies,
    description:
      "The user's connectors, hosted and local: on or off, status, last error, what is missing; host sees what passes through. query: also ones Scient can add; prefer hosting Official. Gmail, Outlook etc. come through each agent's own account. Add with scient_connector_add before making one.",
    parameters: Schema.Struct({
      query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
        description: "e.g. slack.",
      }),
    }),
    success: Schema.Struct({
      connectors: Schema.Array(
        Schema.Struct({
          connector: Schema.String,
          name: Schema.String,
          kind: Schema.Literals(["hosted", "local"]),
          host: Schema.optional(Schema.String),
          on: Schema.Boolean,
          status: ConnectorStatus,
          lastError: Schema.optional(Schema.String),
          missing: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      found: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            title: Schema.optional(Schema.String),
            description: Schema.optional(Schema.String),
            host: Schema.optional(Schema.String),
            hosting: Schema.String,
            addable: Schema.Boolean,
            reason: Schema.optional(Schema.String),
            added: Schema.optional(Schema.String),
          }),
        ),
      ),
      message: Schema.optional(Schema.String),
    }),
  }),
  "connector-list",
  "List connectors",
  true,
);
const connectorAdd = metadata(
  Tool.make("scient_connector_add", {
    failure: AccountsError,
    dependencies: [...connectorDependencies, OrchestratorMcpService, SecretRequests],
    description:
      "Add a connector as the Extensions page does, on for every project: from = a name from scient_connector_list, an https MCP address, or a .mcpb/.zip file. A key or the user's own sign-in app is asked in a private card; never ask for one in chat. needs-setup: scient_connector_setup. needs-sign-in: scient_connector_control sign-in.",
    parameters: Schema.Struct({
      from: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
    }),
    success: Schema.Struct({
      connector: Schema.String,
      status: ConnectorStatus,
      tools: Schema.Array(Schema.String),
      missing: Schema.Array(Schema.String),
      message: Schema.String,
    }),
  }),
  "connector-add",
  "Add a connector",
);
const connectorControl = metadata(
  Tool.make("scient_connector_control", {
    failure: AccountsError,
    // A restart starts the connector once, with only what the chat's project may use.
    dependencies: connectorDependencies,
    description:
      "Turn a connector on or off, restart a local one, or sign in: a hosted connector's sign-in opens in this chat's browser as the user's own tab, which your preview tools don't see, for them to finish. Removing stays the user's.",
    parameters: Schema.Struct({
      connector: TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
        description: "Its MCP server name.",
      }),
      action: Schema.Literals(["on", "off", "restart", "sign-in"]),
    }),
    success: Schema.Struct({
      connector: Schema.String,
      status: ConnectorStatus,
      message: Schema.String,
      signInUrl: Schema.optional(Schema.String),
    }),
  }),
  "connector-control",
  "Control a connector",
);
const connectorCopy = metadata(
  Tool.make("scient_connector_copy", {
    failure: AccountsError,
    dependencies: connectorDependencies,
    description:
      "Make or fix a local connector (load the connector-authoring skill first). name: writes the template to connectors/<name>/ in this chat's folder. connector: copies that installed connector there, with its status, last error and error output; an npm or PyPI package's code comes too (source says where). Then scient_connector_check, then scient_connector_save.",
    parameters: Schema.Struct({
      connector: Schema.optional(ConnectorName).annotate({
        description: "Its MCP server name.",
      }),
      name: Schema.optional(ConnectorName).annotate({
        description: "e.g. HUJI Moodle.",
      }),
    }),
    success: Schema.Struct({
      folder: Schema.String,
      connector: Schema.optional(Schema.String),
      status: Schema.optional(ConnectorStatus),
      lastError: Schema.optional(Schema.String),
      problem: Schema.optional(Schema.String),
      missing: Schema.optional(Schema.Array(Schema.String)),
      log: Schema.optional(Schema.String),
      source: Schema.optional(Schema.String),
      manifest: Schema.optional(
        Schema.Struct({
          name: Schema.String,
          version: Schema.String,
          runtime: Schema.String,
          entryPoint: Schema.String,
          settings: Schema.Array(Schema.String),
          signInSite: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
  "connector-copy",
  "Copy a connector to change",
);
const connectorCheck = metadata(
  Tool.make("scient_connector_check", {
    failure: AccountsError,
    dependencies: connectorDependencies,
    description:
      "Start a connector folder as Scient would, list its tools, make each call, stop it; installs nothing. connector: use its settings, keys and sign-in. signIn: an Accounts sign-in for the manifest's site. Missing keys are listed in missing; a failure returns the error and error output. connector without folder: tests the installed one, hosted too, and makes calls; that is how to use one added in this chat.",
    parameters: Schema.Struct({
      folder: Schema.optional(FolderPath),
      connector: Schema.optional(ConnectorName),
      signIn: Schema.optional(ConnectorName),
      calls: Schema.optional(
        Schema.Array(
          Schema.Struct({
            tool: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
            arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
          }),
        ).check(Schema.isMaxLength(10)),
      ),
    }),
    success: Schema.Struct({
      ok: Schema.Boolean,
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          parameters: Schema.optional(Schema.Unknown),
        }),
      ),
      calls: Schema.Array(
        Schema.Struct({ tool: Schema.String, isError: Schema.Boolean, text: Schema.String }),
      ),
      missing: Schema.Array(Schema.String),
      error: Schema.optional(Schema.String),
      log: Schema.optional(Schema.String),
    }),
  }),
  "connector-check",
  "Check a connector folder",
);
const connectorSave = metadata(
  Tool.make("scient_connector_save", {
    failure: AccountsError,
    dependencies: connectorDependencies,
    description:
      "Install a checked connector folder as the user's own, on for every project. connector: replace that one, keeping its settings, keys and sign-in (a vendor's bundle becomes their copy). The user can undo on its page. needs-setup: call scient_connector_setup.",
    parameters: Schema.Struct({ folder: FolderPath, connector: Schema.optional(ConnectorName) }),
    success: Schema.Struct({
      connector: Schema.String,
      status: ConnectorStatus,
      tools: Schema.Array(Schema.String),
      missing: Schema.Array(Schema.String),
      message: Schema.String,
    }),
  }),
  "connector-save",
  "Save a connector",
);
const paperDependencies = [
  ...common.dependencies,
  FileSystem.FileSystem,
  Path.Path,
  WorkspaceBindingResolver,
];
const AddToLibrary = Schema.Boolean.annotate({
  description:
    "For the user's Library: file the PDF on the Source with its DOI, adding a missing Source from its registry record, credited to you.",
});
const LibrarySourceId = TrimmedNonEmptyString.annotate({
  description: "Attach the PDF to this Library source instead of finding one by DOI.",
});
const paperGet = metadata(
  Tool.make("scient_paper_get", {
    failure: AccountsError,
    dependencies: paperDependencies,
    description:
      "The first step to fetch any paper's PDF: give its DOI or link (for a title, find one first), and Scient saves it in the project from a free legal copy or the user's university access in the browser, preferring the published version. Returns its path, or why it can't arrive yet. For the user's Library set addToLibrary. For more than a few papers use scient_papers_queue.",
    parameters: Schema.Struct({
      doi: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
      url: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
      addToLibrary: Schema.optional(AddToLibrary),
      sourceId: Schema.optional(LibrarySourceId),
    }),
    success: Schema.Union([
      Schema.Struct({
        status: Schema.Literal("saved"),
        path: Schema.String,
        route: Schema.Literals([
          "saved-before",
          "open-access",
          "publisher",
          "university",
          "library",
        ]),
        published: Schema.Boolean.annotate({
          description: "False for an accepted manuscript or preprint.",
        }),
        version: Schema.optional(PaperVersion),
        title: Schema.optional(Schema.String),
        doi: Schema.optional(Schema.String),
        sourceId: Schema.optional(
          Schema.String.annotate({ description: "The Library source the PDF is on." }),
        ),
        through: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        status: Schema.Literals(["not-found", "no-access", "needs-you", "waiting"]),
        message: Schema.String,
      }),
    ]),
  }),
  "paper-get",
  "Get a paper's PDF",
);
const paperQueue = metadata(
  Tool.make("scient_papers_queue", {
    failure: AccountsError,
    dependencies: paperDependencies,
    description:
      "Queue any number of papers, each by DOI or link, and keep working. Scient fetches them in the background into the project's papers folder, one at a time per publisher, and they continue after this turn. If a sign-in is needed Scient asks the user once and every paper waiting continues. Read results with scient_papers_status.",
    parameters: Schema.Struct({
      papers: Schema.Array(
        Schema.Struct({
          doi: PaperAsked.fields.doi,
          url: PaperAsked.fields.url,
          addToLibrary: Schema.optional(AddToLibrary),
          sourceId: Schema.optional(LibrarySourceId),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
    }),
    success: Schema.Struct({ queued: Schema.Number, message: Schema.optional(Schema.String) }),
  }),
  "paper-queue",
  "Queue papers to fetch",
);
const paperStatus = metadata(
  Tool.make("scient_papers_status", {
    failure: AccountsError,
    dependencies: paperDependencies,
    description:
      "Where this project's queued papers stand: counts, then each paper with its state, path and reason. needs-you means it waits for the user, who has been asked; no-access means it can't be reached, so say so rather than treating the paper as read. Filter with state; continue with nextOffset.",
    parameters: Schema.Struct({
      state: Schema.optional(PaperItemState),
      offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
    success: Schema.Struct({
      waiting: Schema.Number,
      saved: Schema.Number,
      needsYou: Schema.Number,
      notFound: Schema.Number,
      noAccess: Schema.Number,
      items: Schema.Array(
        Schema.Struct({
          state: PaperItemState,
          doi: PaperItem.fields.doi,
          url: PaperItem.fields.url,
          title: PaperItem.fields.title,
          route: PaperItem.fields.route,
          published: PaperItem.fields.published,
          version: PaperItem.fields.version,
          path: PaperItem.fields.path,
          sourceId: PaperItem.fields.sourceId,
          message: PaperItem.fields.message,
        }),
      ),
      nextOffset: Schema.optional(Schema.Number),
    }),
  }),
  "paper-status",
  "Read queued papers",
  true,
);
const Page = {
  cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
};
const Tighter = {
  access: Schema.optional(Schema.Literals(["ask", "off"])),
  scope: Schema.optional(
    Schema.Array(ProjectId).annotate({ description: "Narrow to these projects only." }),
  ),
};
const ManagedAccount = Schema.Struct({
  accountId: AccountId,
  name: Schema.String,
  kind: Schema.String,
  sites: Schema.Array(Schema.String),
  username: Schema.optional(Schema.String),
  envName: Schema.optional(Schema.String),
  oneSession: Schema.optional(Schema.Boolean),
  access: Schema.String,
  readable: Schema.Boolean,
  scope: Schema.optional(Schema.Array(Schema.String)),
  version: Schema.String,
  signIn: Schema.optional(Schema.String),
  lastWorked: Schema.optional(Schema.String),
});
const accountManage = metadata(
  Tool.make("scient_account_manage", {
    ...common,
    description:
      "Manage a saved account, never its value: get (its version), activity, edit (name, a website's username, fewer sites, or oneSession: a new sign-in there ends the other session, so Scient never signs in by itself), controls (only tighter), remove (with Undo), undo, check_all (looks, never signs in), save_offer (offer to save again), pin_task/unpin_task (a scheduledTaskId runs only as this sign-in, in its profile, on this computer; each run checks first). Writes take the version read and are shown to the user with this chat. Only the user loosens controls: using an Off account asks them to turn it on.",
    parameters: Schema.Struct({
      action: Schema.Literals([
        "get",
        "activity",
        "edit",
        "controls",
        "remove",
        "undo",
        "check_all",
        "save_offer",
        "pin_task",
        "unpin_task",
      ]),
      accountId: Schema.optional(AccountId),
      scheduledTaskId: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      version: Schema.optional(Schema.String),
      name: Schema.optional(AccountSummary.fields.name),
      username: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
      sites: Schema.optional(Schema.Array(AccountSite)),
      oneSession: Schema.optional(Schema.Boolean),
      ...Tighter,
      hidden: Schema.optional(Schema.Literal(true)),
      readOnly: Schema.optional(Schema.Literal(true)),
      undo: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      ...Page,
    }),
    success: Schema.Struct({
      account: Schema.optional(ManagedAccount),
      entries: Schema.optional(
        Schema.Array(
          Schema.Struct({
            at: Schema.String,
            action: Schema.String,
            outcome: Schema.optional(Schema.String),
            detail: Schema.optional(Schema.String),
            byChat: Schema.optional(Schema.String),
          }),
        ),
      ),
      checked: Schema.optional(
        Schema.Array(
          Schema.Struct({
            accountId: AccountId,
            name: Schema.String,
            state: Schema.String,
            reason: Schema.optional(Schema.String),
          }),
        ),
      ),
      undo: Schema.optional(Schema.String),
      undoUntil: Schema.optional(Schema.String),
      nextCursor: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  }),
  "manage",
  "Manage an account",
);
const browserProfiles = metadata(
  Tool.make("scient_browser_profiles", {
    ...common,
    description:
      "Browser profiles in this session: list, sites (a profile's saved sign-ins, never cookies), and at the version from list: controls (only tighter: access, scope, or scriptSignIn false), sign_out (a site), clear, remove, transfer (copy or move sites into another profile), merge (all into another, then remove), fold_main (merge into Main), sources (the user's browser profiles on their desktops), import from a sourceId (cookies and/or passwords) into a new profile, or into profileId if no wider, and refresh from its link. Each is the user's own action; all but an import or refresh have their Undo for an hour. Pass operationId to undo or status; an import may wait for the user to allow the browser, so check status. Nothing reaches further than it did; tabs open in chats stop a remove or merge, and the reply names them.",
    parameters: Schema.Struct({
      action: Schema.Literals([
        "list",
        "sites",
        "controls",
        "sign_out",
        "clear",
        "remove",
        "transfer",
        "merge",
        "fold_main",
        "sources",
        "import",
        "refresh",
        "undo",
        "status",
      ]),
      cookies: Schema.optional(Schema.Boolean),
      passwords: Schema.optional(Schema.Boolean),
      into: Schema.optional(BrowserProfileId),
      mode: Schema.optional(Schema.Literals(["copy", "move"])),
      sites: Schema.optional(Schema.Array(AccountSite).check(Schema.isMaxLength(100))),
      profileId: Schema.optional(BrowserProfileId),
      version: Schema.optional(Schema.String),
      site: Schema.optional(AccountSite),
      operationId: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
      sourceId: Schema.optional(Schema.String.check(Schema.isMaxLength(400))),
      ...Tighter,
      scriptSignIn: Schema.optional(Schema.Literal(false)),
      ...Page,
    }),
    success: Schema.Struct({
      profiles: Schema.optional(
        Schema.Array(
          Schema.Struct({
            profileId: BrowserProfileId,
            version: Schema.String,
            name: Schema.String,
            access: Schema.String,
            scope: Schema.optional(Schema.Array(Schema.String)),
            scriptSignIn: Schema.Boolean,
            fromAnotherComputer: Schema.optional(Schema.Boolean),
          }),
        ),
      ),
      sources: Schema.optional(
        Schema.Array(
          Schema.Struct({
            sourceId: Schema.String,
            name: Schema.String,
            email: Schema.optional(Schema.String),
            computer: Schema.String,
            linkedTo: Schema.optional(BrowserProfileId),
            offline: Schema.optional(Schema.Boolean),
          }),
        ),
      ),
      sites: Schema.optional(
        Schema.Array(
          Schema.Struct({
            site: Schema.String,
            accountId: AccountId,
            username: Schema.optional(Schema.String),
            signIn: Schema.optional(Schema.String),
          }),
        ),
      ),
      operation: Schema.optional(
        Schema.Struct({
          operationId: Schema.String,
          kind: Schema.String,
          undoUntil: Schema.String,
          server: Schema.optional(Schema.String),
          desktop: Schema.optional(Schema.String),
          notCopied: Schema.optional(Schema.Array(Schema.String)),
          stopped: Schema.optional(Schema.String),
          undone: Schema.optional(Schema.Boolean),
          keptSince: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      /** The profile an import made. */
      profileId: Schema.optional(BrowserProfileId),
      openIn: Schema.optional(Schema.Array(Schema.String)),
      nextCursor: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  }),
  "browser-profiles",
  "Manage browser profiles",
);
export const ScientAccountsToolkit = Toolkit.make(
  list,
  accountManage,
  browserProfiles,
  credentials,
  signIn,
  fill,
  request,
  browserSession,
  check,
  findProfile,
  add,
  connectorSetup,
  connectorList,
  connectorAdd,
  connectorControl,
  connectorCopy,
  connectorCheck,
  connectorSave,
  paperGet,
  paperQueue,
  paperStatus,
);
