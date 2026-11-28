import "../../index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  ThreadId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { UniversityCrest } from "./University";

const state = vi.hoisted(() => ({
  accounts: [] as AccountSummary[],
  calls: [] as unknown[],
  cleared: [] as string[],
  /** Whether the server still has this sign-out open when the client asks. */
  open: true,
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => "synthetic",
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => () => undefined,
}));
vi.mock("./useSignIn", () => ({ useSignIn: () => async () => true }));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({
    data: { accounts: state.accounts, attempts: [], signInEnds: [], accountsProtocol: 2 },
    canWrite: true,
  }),
  useAccountCommand: (command: { label: string }) => async (input: unknown) => {
    state.calls.push([command.label, input]);
    if (command.label === "accounts:universitySignOut")
      return {
        ok: true,
        value: {
          opId: "op-1",
          sites: [
            { profileId: DEFAULT_BROWSER_PROFILE_ID, site: "huji.ac.il" },
            { profileId: DEFAULT_BROWSER_PROFILE_ID, site: "openathens.net" },
          ],
        },
      };
    if (command.label === "accounts:read-snapshot")
      return { ok: true, value: { universitySignOuts: state.open ? [{ opId: "op-1" }] : [] } };
    return { ok: true, value: { checked: 1 } };
  },
}));

const university = (id: string, details: Record<string, unknown>): AccountSummary =>
  ({
    accountId: AccountId.make(id),
    name: id === "acc_huji_directory" ? "Hebrew University" : "HUJI library",
    details: { kind: "website", sites: ["huji.ac.il"], ...details },
    secrets: {},
    controls: defaultAccountControls("website"),
    status: "ready",
    signIn: { state: "signed-in", at: "2026-11-25T18:00:00.000Z" },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  }) as AccountSummary;

it("shows the old library row and the directory row as one university, and signs it out", async () => {
  state.accounts = [
    university("acc_huji_library", {
      proxyUrl: "https://go.openathens.net/redirector/huji.ac.il?url={url}",
    }),
    university("acc_huji_directory", {
      institution: {
        name: "Hebrew University",
        entityId: "https://idp.huji.ac.il/openathens",
        domain: "huji.ac.il",
      },
    }),
  ];
  const bridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      accounts: {
        signOutSite: async () => true,
        signOutMainSite: async (site: string) => {
          state.cleared.push(site);
          return true;
        },
      },
    },
  });
  try {
    await using _screen = await render(
      <UniversityCrest
        environmentId={EnvironmentId.make("synthetic")}
        threadId={ThreadId.make("synthetic-thread")}
      />,
    );
    await page.getByRole("button", { name: "University: Hebrew University" }).click();
    await expect.element(page.getByText("HUJI library")).not.toBeInTheDocument();
    await expect.element(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    // Removing a university login lives only in Accounts & secrets, where it has Undo.
    await expect.element(page.getByRole("menuitem", { name: "Remove" })).not.toBeInTheDocument();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await vi.waitFor(() => expect(state.cleared).toEqual(["huji.ac.il", "openathens.net"]));
    // Every site it named was cleared, and reported so for that very sign-out.
    await vi.waitFor(() =>
      expect(state.calls.at(-1)).toEqual([
        "accounts:universitySignOut",
        {
          accountId: "acc_huji_directory",
          opId: "op-1",
          cleared: [
            { profileId: DEFAULT_BROWSER_PROFILE_ID, site: "huji.ac.il" },
            { profileId: DEFAULT_BROWSER_PROFILE_ID, site: "openathens.net" },
          ],
        },
      ]),
    );
    // The server records the sign-out and each host first; this client only clears them.
    expect(
      state.calls.filter((call) => (call as [string])[0] === "accounts:profileSignedOut"),
    ).toEqual([]);
  } finally {
    if (bridge) Object.defineProperty(window, "desktopBridge", bridge);
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});

it("stops clearing once a newer sign-in ended the sign-out, so that session stays", async () => {
  state.cleared = [];
  state.calls = [];
  state.open = false;
  const bridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      accounts: {
        signOutSite: async () => true,
        signOutMainSite: async (site: string) => {
          state.cleared.push(site);
          return true;
        },
      },
    },
  });
  try {
    await using _screen = await render(
      <UniversityCrest
        environmentId={EnvironmentId.make("synthetic")}
        threadId={ThreadId.make("synthetic-thread")}
      />,
    );
    await page.getByRole("button", { name: "University: Hebrew University" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await vi.waitFor(() =>
      expect(state.calls.at(-1)).toMatchObject(["accounts:universitySignOut", { cleared: [] }]),
    );
    expect(state.cleared).toEqual([]);
  } finally {
    state.open = true;
    if (bridge) Object.defineProperty(window, "desktopBridge", bridge);
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});
