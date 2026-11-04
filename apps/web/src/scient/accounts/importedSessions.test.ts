import { AccountId, defaultAccountControls, type AccountSummary } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { importedSessionSites } from "./importedSessions";

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
