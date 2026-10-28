import {
  ConnectorId,
  AccountId,
  type AccountSummary,
  defaultAccountControls,
  type ConnectorSummary,
  type DiscoverEntry,
  EnvironmentId,
  ExtensionsError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render as renderScreen, stubGlobal, type Screen } from "../../../test/render";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

const state = vi.hoisted(() => ({
  add: vi.fn(),
  startSignIn: vi.fn(),
  toast: vi.fn(),
  onOpenChange: vi.fn(),
  accountsAvailable: false,
  accounts: [] as AccountSummary[],
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    isSuccess: state.accountsAvailable,
    data: { accounts: state.accounts },
  }),
}));
vi.mock("./extensionsState", () => ({
  addConnector: "add",
  startConnectorSignIn: "start-sign-in",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "add" ? state.add : state.startSignIn),
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../../components/chat/providerIconUtils", () => ({ AVAILABLE_PROVIDER_OPTIONS: [] }));

import { AddConnectorDialog } from "./AddConnectorDialog";

const environmentId = EnvironmentId.make("local");

const connector: ConnectorSummary = {
  connectorId: ConnectorId.make("con_linear0001"),
  serverName: "linear",
  displayName: "Linear",
  url: "https://mcp.linear.app/mcp",
  source: { type: "url" },
  auth: { type: "oauth", usesOwnClient: false },
  status: "needs-auth",
  authRevision: 0,
  enabled: true,
  availability: { type: "all-projects" },
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

function setup() {
  state.accountsAvailable = false;
  state.accounts = [];
  state.add.mockReset();
  state.startSignIn.mockReset();
  state.toast.mockReset();
  state.onOpenChange.mockReset();
  const stack = new AsyncDisposableStack();
  let screen: Screen | undefined;
  return {
    async render(entry: DiscoverEntry | null = null) {
      const ui = (
        <AddConnectorDialog
          open
          onOpenChange={state.onOpenChange}
          environmentId={environmentId}
          entry={entry}
          callbackOrigin="http://127.0.0.1:3773"
        />
      );
      if (screen) await screen.rerender(ui);
      else screen = stack.use(await renderScreen(ui));
    },
    async reset() {
      await screen?.[Symbol.asyncDispose]();
      screen = undefined;
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const errorText = (id: string) => document.getElementById(`${id}-error`)?.textContent || null;
async function press(label: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
}

async function submit() {
  await press("Add");
}

describe("AddConnectorDialog validation", () => {
  it("shows URL errors only after submitting and never sends an invalid URL", async () => {
    await using fixture = setup();
    await fixture.render();
    expect(errorText("connector-url")).toBeNull();

    await submit();
    expect(errorText("connector-url")).toBe("Enter the server URL.");

    await userEvent.fill(field<HTMLInputElement>("connector-url"), "mcp.example.com");
    expect(errorText("connector-url")).toBe(
      "Enter a full URL, for example https://mcp.example.com/mcp.",
    );
    await userEvent.fill(field<HTMLInputElement>("connector-url"), "http://mcp.example.com/mcp");
    expect(errorText("connector-url")).toBe(
      "Use an https:// URL. Plain http:// is allowed only for this computer.",
    );
    await submit();
    expect(state.add).not.toHaveBeenCalled();
    await userEvent.fill(field<HTMLInputElement>("connector-url"), "http://127.0.0.1:8080/mcp");
    expect(errorText("connector-url")).toBeNull();
  });

  it("requires a key, a valid header name and user:password for API keys", async () => {
    await using fixture = setup();
    await fixture.render();
    await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://api.example.com/mcp");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "api-key");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-strategy"), "header");
    await submit();
    expect(errorText("connector-header-name")).toBe("Enter the header name.");
    expect(errorText("connector-key")).toBe("Enter the key.");

    await userEvent.fill(field<HTMLInputElement>("connector-header-name"), "X API Key");
    expect(errorText("connector-header-name")).toBe("Header names use letters, digits and dashes.");

    await userEvent.selectOptions(field<HTMLSelectElement>("connector-strategy"), "basic");
    expect(field("connector-header-name")).toBeNull();
    await userEvent.fill(field<HTMLInputElement>("connector-key"), "token-only");
    expect(field<HTMLInputElement>("connector-key").value).toBe("token-only");
    expect(errorText("connector-key")).toBe("Use user:password.");
    expect(state.add).not.toHaveBeenCalled();
  });

  it("rejects a client secret without a client ID", async () => {
    await using fixture = setup();
    await fixture.render();
    await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://mcp.example.com/mcp");
    await press("Advanced");
    await userEvent.fill(field<HTMLInputElement>("connector-client-secret"), "shh");
    await submit();
    expect(errorText("connector-client-id")).toBe("Enter the client ID to use a client secret.");
    expect(state.add).not.toHaveBeenCalled();
  });

  it("sends the entered key once and shows the server's rejection", async () => {
    await using fixture = setup();
    state.add.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(
        new ExtensionsError({ reason: "unreachable", message: "The server did not answer." }),
      ),
    });
    await fixture.render();
    await userEvent.fill(field<HTMLInputElement>("connector-url"), " https://api.example.com/mcp ");
    await userEvent.fill(field<HTMLInputElement>("connector-name"), "Example");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "api-key");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-strategy"), "header");
    await userEvent.fill(field<HTMLInputElement>("connector-header-name"), "X-API-Key");
    await userEvent.fill(field<HTMLInputElement>("connector-key"), " sk-123 ");
    await submit();

    expect(state.add).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        target: { type: "url", url: "https://api.example.com/mcp" },
        displayName: "Example",
        credential: {
          type: "entered",
          strategy: "header",
          headerName: "X-API-Key",
          value: "sk-123",
        },
      },
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "The server did not answer. Enter the key again to retry.",
    );
    expect(field<HTMLInputElement>("connector-key").value).toBe("");
    expect(field<HTMLInputElement>("connector-header-name").value).toBe("X-API-Key");
    expect(state.onOpenChange).not.toHaveBeenCalled();
  });

  async function fillApiKey(key: string) {
    await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://api.example.com/mcp");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "api-key");
    await userEvent.fill(field<HTMLInputElement>("connector-key"), key);
  }

  it("clears the key from the form while the request is pending", async () => {
    await using fixture = setup();
    const pending = Promise.withResolvers<unknown>();
    state.add.mockReturnValueOnce(pending.promise);
    await fixture.render();
    await fillApiKey("sk-pending");
    await submit();
    expect(state.add.mock.calls[0]?.[0].input.credential.value).toBe("sk-pending");
    expect(field<HTMLInputElement>("connector-key").value).toBe("");
    expect(errorText("connector-key")).toBeNull();
    await act(async () =>
      pending.resolve({ _tag: "Success", value: { connector, nextStep: "ready" } }),
    );
    expect(state.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears the key after an interrupted request without reporting an error", async () => {
    await using fixture = setup();
    state.add.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.interrupt() });
    await fixture.render();
    await fillApiKey("sk-interrupted");
    await submit();
    expect(field<HTMLInputElement>("connector-key").value).toBe("");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("drops a typed key or client secret when its mode or section is left", async () => {
    await using fixture = setup();
    await fixture.render();
    await fillApiKey("sk-abandoned");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "automatic");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "api-key");
    expect(field<HTMLInputElement>("connector-key").value).toBe("");

    await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "automatic");
    await press("Advanced");
    await userEvent.fill(field<HTMLInputElement>("connector-client-secret"), "client-secret");
    await press("Advanced");
    await press("Advanced");
    expect(field<HTMLInputElement>("connector-client-secret").value).toBe("");
  });

  it("submits from the keyboard, focuses the first invalid field and links its error", async () => {
    await using fixture = setup();
    state.add.mockResolvedValueOnce({ _tag: "Success", value: { connector, nextStep: "ready" } });
    await fixture.render();
    await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://api.example.com/mcp");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "api-key");
    await userEvent.selectOptions(field<HTMLSelectElement>("connector-strategy"), "header");
    await userEvent.fill(field<HTMLInputElement>("connector-key"), "sk-keyboard");
    await userEvent.keyboard("{Enter}");

    const headerName = field<HTMLInputElement>("connector-header-name");
    expect(state.add).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(headerName);
    expect(headerName.getAttribute("aria-invalid")).toBe("true");
    expect(headerName.getAttribute("aria-describedby")).toBe("connector-header-name-error");
    expect(errorText("connector-header-name")).toBe("Enter the header name.");
    expect(field<HTMLInputElement>("connector-key").getAttribute("aria-invalid")).toBeNull();

    await userEvent.fill(headerName, "X-API-Key");
    await userEvent.keyboard("{Enter}");
    expect(state.add).toHaveBeenCalledOnce();
    expect(headerName.getAttribute("aria-describedby")).toBeNull();
  });

  it("adds a registry entry's endpoint and asks to sign in when the server requires it", async () => {
    await using fixture = setup();
    state.add.mockResolvedValueOnce({
      _tag: "Success",
      value: { connector, nextStep: "sign-in-required" },
    });
    await fixture.render({
      name: "app.linear/linear",
      version: "1.0.0",
      title: "Linear",
      remotes: [
        { type: "sse", url: "https://mcp.linear.app/sse", requiresInput: false },
        { type: "streamable-http", url: "https://mcp.linear.app/mcp", requiresInput: false },
      ],
      installable: true,
      categories: [],
    });
    expect([...field<HTMLSelectElement>("connector-remote").options].map((o) => o.value)).toEqual([
      "https://mcp.linear.app/mcp",
    ]);
    await submit();
    expect(state.add).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        target: {
          type: "registry",
          name: "app.linear/linear",
          version: "1.0.0",
          url: "https://mcp.linear.app/mcp",
        },
        displayName: "Linear",
      },
    });
    expect(document.body.textContent).toContain("Sign in to Linear");
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("sends the entry's description, trimmed and capped at 1000 characters", async () => {
    await using fixture = setup();
    state.add.mockResolvedValue({ _tag: "Success", value: { connector, nextStep: "ready" } });
    const registryEntry = (description: string): DiscoverEntry => ({
      name: "io.example/notes",
      version: "2.0.0",
      title: "Notes",
      description,
      remotes: [
        { type: "streamable-http", url: "https://notes.example.com/mcp", requiresInput: false },
      ],
      installable: true,
      categories: [],
    });
    await fixture.render(registryEntry(`  ${"a".repeat(1200)}  `));
    await submit();
    expect(state.add.mock.calls[0]?.[0].input.description).toBe("a".repeat(1000));

    await fixture.reset();
    await fixture.render(registryEntry("   "));
    await submit();
    expect(state.add.mock.calls[1]?.[0].input).not.toHaveProperty("description");
  });

  async function renderSignInStep(renderEntry: () => Promise<void>) {
    state.add.mockResolvedValueOnce({
      _tag: "Success",
      value: { connector, nextStep: "sign-in-required" },
    });
    await renderEntry();
    await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://mcp.linear.app/mcp");
    await submit();
  }

  it("keeps the sign-in step open with the server's reason when sign-in is refused", async () => {
    await using fixture = setup();
    const reserved = { opener: {}, location: { href: "" }, close: vi.fn(), closed: false };
    using _window = stubGlobal(
      "open",
      vi.fn(() => reserved),
    );
    state.startSignIn.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(
        new ExtensionsError({ reason: "sign-in-failed", message: "No authorization server." }),
      ),
    });
    await renderSignInStep(fixture.render);
    await press("Sign in");
    expect(reserved.close).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("No authorization server.");
    expect(state.onOpenChange).not.toHaveBeenCalled();
  });

  it("offers the sign-in page as a link when the browser blocks the window", async () => {
    await using fixture = setup();
    using _window = stubGlobal(
      "open",
      vi.fn(() => null),
    );
    state.startSignIn.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        authorizationUrl: "https://auth.linear.app/authorize?state=1",
        expiresAt: "2026-10-21T00:10:00.000Z",
      },
    });
    await renderSignInStep(fixture.render);
    await press("Sign in");
    const link = [...document.querySelectorAll("a")].find(
      (item) => item.textContent === "Open sign-in page",
    );
    expect(link?.getAttribute("href")).toBe("https://auth.linear.app/authorize?state=1");
    expect(state.onOpenChange).not.toHaveBeenCalled();
  });

  it("closes once the sign-in page has opened", async () => {
    await using fixture = setup();
    const reserved = { opener: {}, location: { href: "" }, close: vi.fn(), closed: false };
    using _window = stubGlobal(
      "open",
      vi.fn(() => reserved),
    );
    state.startSignIn.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        authorizationUrl: "https://auth.linear.app/authorize?state=2",
        expiresAt: "2026-10-21T00:10:00.000Z",
      },
    });
    await renderSignInStep(fixture.render);
    await press("Sign in");
    expect(reserved.location.href).toBe("https://auth.linear.app/authorize?state=2");
    expect(state.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

it("binds a matching account without retaining the entered key and blocks a changed origin", async () => {
  await using fixture = setup();
  const accountId = AccountId.make("acc_synthetic01");
  state.accountsAvailable = true;
  state.add.mockResolvedValue({ _tag: "Success", value: { connector, nextStep: "ready" } });
  state.accounts = [
    {
      accountId,
      name: "Synthetic API",
      details: { kind: "api-key", sites: ["example.com"], auth: { type: "bearer" } },
      secrets: { token: { source: { type: "scient" } } },
      controls: defaultAccountControls("api-key"),
      status: "ready",
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
    },
  ];
  await fixture.render();
  await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://api.example.com/mcp");
  await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "api-key");
  await userEvent.fill(
    field<HTMLInputElement>("connector-key"),
    crypto.getRandomValues(new Uint32Array(8)).join("-"),
  );
  await userEvent.selectOptions(field<HTMLSelectElement>("connector-account"), accountId);
  await userEvent.selectOptions(field<HTMLSelectElement>("connector-account"), "");
  expect(field<HTMLInputElement>("connector-key").value).toBe("");
  await userEvent.selectOptions(field<HTMLSelectElement>("connector-account"), accountId);
  await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://example.net/mcp");
  await submit();
  expect(state.add).not.toHaveBeenCalled();
  await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://api.example.com/mcp");
  await submit();
  const input = state.add.mock.calls[0]?.[0].input;
  expect(input.credential).toEqual({
    type: "bound",
    strategy: "bearer",
    secretRef: `account:${accountId}:token`,
  });
  await fixture.reset();
  state.accountsAvailable = false;
  await fixture.render();
  await userEvent.fill(field<HTMLInputElement>("connector-url"), "https://api.example.com/mcp");
  await userEvent.selectOptions(field<HTMLSelectElement>("connector-auth"), "api-key");
  expect(document.getElementById("connector-account")).toBeNull();
});

const curatedEntry = (extra: Partial<DiscoverEntry>): DiscoverEntry => ({
  name: "scient.curated/test",
  version: "1",
  title: "Test service",
  categories: ["data"],
  remotes: [{ type: "streamable-http", url: "https://api.example.com/mcp", requiresInput: false }],
  installable: true,
  ...extra,
});

describe("curated connector setup", () => {
  it("requires a registered OAuth client and clears its secret after submission", async () => {
    await using fixture = setup();
    state.add.mockResolvedValue({
      _tag: "Success",
      value: { connector, nextStep: "sign-in-required" },
    });
    await fixture.render(curatedEntry({ oauthClientRequired: true }));
    await submit();
    expect(state.add).not.toHaveBeenCalled();
    await userEvent.fill(field<HTMLInputElement>("connector-client-id"), "synthetic-client");
    await userEvent.fill(field<HTMLInputElement>("connector-client-secret"), "synthetic-secret");
    await submit();
    expect(state.add.mock.calls[0]?.[0].input.oauthClient).toEqual({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
    });
    expect(document.body.textContent).toContain("Sign in to Linear");
  });

  it("sends a preconfigured key through credentials and clears it after failure", async () => {
    await using fixture = setup();
    state.add.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new ExtensionsError({ reason: "unreachable", message: "Try again" })),
    });
    await fixture.render(
      curatedEntry({
        apiKey: {
          strategy: "header",
          headerName: "X-API-Key",
          fieldLabel: "Data Commons API key",
          helpUrl: "https://apikeys.datacommons.org",
        },
      }),
    );
    await submit();
    expect(state.add).not.toHaveBeenCalled();
    await page.getByLabelText("Data Commons API key", { exact: true }).fill("synthetic-key");
    await submit();
    expect(state.add.mock.calls[0]?.[0].input).toMatchObject({
      target: { type: "url", url: "https://api.example.com/mcp" },
      credential: {
        type: "entered",
        value: "synthetic-key",
        strategy: "header",
        headerName: "X-API-Key",
      },
    });
    expect(field<HTMLInputElement>("connector-key").value).toBe("");
  });

  it("rejects a foreign tenant address and submits an exact https tenant endpoint", async () => {
    await using fixture = setup();
    state.add.mockResolvedValue({
      _tag: "Success",
      value: { connector, nextStep: "sign-in-required" },
    });
    await fixture.render(
      curatedEntry({
        address: {
          urlTemplate: "https://<tenant>.mcp.benchling.com/mcp",
          fieldLabel: "Your Benchling address",
          placeholder: "https://your-lab.mcp.benchling.com/mcp",
        },
      }),
    );
    const address = page.getByLabelText("Your Benchling address", { exact: true });
    await address.fill("https://lab.mcp.benchling.com.evil.example/mcp");
    await submit();
    expect(state.add).not.toHaveBeenCalled();
    await address.fill("https://lab.mcp.benchling.com/mcp");
    await submit();
    expect(state.add.mock.calls[0]?.[0].input.target).toEqual({
      type: "url",
      url: "https://lab.mcp.benchling.com/mcp",
    });
    expect(document.body.textContent).toContain("Sign in to Linear");
  });
});
