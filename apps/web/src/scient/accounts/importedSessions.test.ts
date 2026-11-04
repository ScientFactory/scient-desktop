import {
  AccountId,
  EnvironmentId,
  defaultAccountControls,
  type AccountSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./accountsState", () => ({
  accountsState: {
    readSnapshot: {
      run: async () => ({
        _tag: "Success",
        value: { accounts: [], features: { sessionsSeen: true } },
      }),
    },
    sessionsSeen: {
      run: async (_registry: unknown, { input }: { input: { sessions: unknown[] } }) => {
        calls.push(`rows:${input.sessions.length}`);
        return { _tag: "Success", value: { created: [] } };
      },
    },
  },
}));
vi.mock("./mainFill", () => ({
  fillMainFromProfile: async (_environmentId: string, profileId: string) =>
    void calls.push(`fill:${profileId}`),
}));

const { importedSessionSites, recordImportedSessions } = await import("./importedSessions");

const now = Date.parse("2026-11-04T00:00:00.000Z");
const row = (sites: string[], patch: Partial<AccountSummary> = {}): AccountSummary => ({
  accountId: AccountId.make(`acc_imported_${sites[0]!.replace(/\W/g, "")}`),
  name: sites[0]!,
  details: { kind: "website", sites },
  secrets: { password: { source: { type: "scient" } } },
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...patch,
});
const session = (domain: string, expires?: number) => ({
  domain,
  httpOnly: true,
  ...(expires === undefined ? {} : { expires }),
});

it("keeps a live protected session on a saved-password or catalogue site, by its shortest domain", () => {
  const sites = importedSessionSites(
    [
      // Catalogue: GitHub and Overleaf.
      session(".github.com"),
      session("github.com"),
      session("www.overleaf.com"),
      // A saved password's site, and one whose only cookie is readable by scripts.
      session(".lab.example.org", now / 1000 + 60),
      { domain: "notes.example.net", httpOnly: false },
      // Expired, and a site with neither a password nor a catalogue entry.
      session("kaggle.com", now / 1000 - 60),
      session("unrelated.example"),
    ],
    [row(["https://portal.lab.example.org"]), row(["notes.example.net"])],
    now,
  );
  expect(sites).toEqual(["lab.example.org", "github.com", "overleaf.com"]);
});

it("leaves out Google, sign-in services and a university's sign-in, and caps each profile", () => {
  const university = row(["huji.ac.il", "https://idp.cc.huji.ac.il"], {
    details: {
      kind: "website",
      sites: ["huji.ac.il", "https://idp.cc.huji.ac.il"],
      institution: { name: "HUJI", entityId: "https://idp.huji.ac.il", domain: "huji.ac.il" },
    },
  });
  expect(
    importedSessionSites(
      [session(".google.com"), session("login.microsoftonline.com"), session(".huji.ac.il")],
      [
        university,
        row(["accounts.google.com"]),
        row(["login.microsoftonline.com"]),
        row(["huji.ac.il"]),
      ],
      now,
    ),
  ).toEqual([]);
  const many = Array.from({ length: 250 }, (_, index) => `site${index}.example`);
  expect(
    importedSessionSites(
      many.map((site) => session(site)),
      many.map((site) => row([site])),
      now,
    ),
  ).toHaveLength(200);
});

it("makes an import's rows, then fills Main from it once", async () => {
  vi.stubGlobal("window", {
    desktopBridge: {
      accounts: { cookieMetadata: async () => [session("github.com"), session("overleaf.com")] },
    },
  });
  try {
    const environmentId = EnvironmentId.make("synthetic");
    await recordImportedSessions(environmentId, "work", "Chrome · Work", { fillMain: true });
    expect(calls).toEqual(["rows:2", "fill:work"]);
    // A profile imported before brought nothing new this time: no fill.
    calls.length = 0;
    await recordImportedSessions(environmentId, "work", "Chrome · Work", { fillMain: false });
    expect(calls).toEqual(["rows:2"]);
  } finally {
    vi.unstubAllGlobals();
  }
});
