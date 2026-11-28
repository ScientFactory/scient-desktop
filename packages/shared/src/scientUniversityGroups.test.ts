import type { AccountSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { glanceKey, signOutHosts, universityGroups } from "./scientUniversityGroups.ts";

const HUJI = {
  name: "Hebrew University",
  entityId: "https://idp.huji.ac.il/openathens",
  domain: "huji.ac.il",
};
const row = (accountId: string, details: Record<string, unknown>, name = accountId) =>
  ({
    accountId,
    name,
    details: { kind: "website", sites: ["huji.ac.il"], ...details },
    secrets: {},
  }) as unknown as AccountSummary;

describe("university groups", () => {
  it("shows the old library row and the directory row as one university with both routes", () => {
    const library = row("acc_library", {
      proxyUrl: "https://go.openathens.net/redirector/huji.ac.il?url={url}",
      username: "Corcos.Yaacov",
    });
    const directory = row("acc_directory", { institution: HUJI });
    const [group, ...others] = universityGroups([library, directory]);
    expect(others).toEqual([]);
    expect(group?.rows.map((item) => item.accountId)).toEqual(["acc_directory", "acc_library"]);
    // The directory row names no one, so it joins the one membership there is.
    expect(group?.memberships).toHaveLength(1);
  });

  it("joins a library host under the university's domain, and keeps usernames apart", () => {
    const directory = row("acc_directory", { institution: HUJI, username: "student@huji.ac.il" });
    const proxy = row("acc_proxy", {
      proxyUrl: "https://ezproxy.huji.ac.il/login?url={url}",
      username: "staff@huji.ac.il",
    });
    const [group] = universityGroups([directory, proxy]);
    expect(group?.rows).toHaveLength(2);
    expect(group?.memberships.map(({ username }) => username)).toEqual([
      "student@huji.ac.il",
      "staff@huji.ac.il",
    ]);
  });

  it("never ties two universities through a host they share", () => {
    const first = row("acc_a", {
      proxyUrl: "https://login.idm.oclc.org/login?url={url}",
      sites: ["a.edu"],
    });
    const second = row("acc_b", {
      proxyUrl: "https://login.idm.oclc.org/login?url={url}",
      sites: ["b.edu"],
    });
    expect(universityGroups([first, second])).toHaveLength(2);
  });
});

it("signs out of the university's own hosts and OpenAthens, never Google", () => {
  const signedIn = row("acc_directory", {
    institution: HUJI,
    sites: ["huji.ac.il", "https://idp.cc.huji.ac.il", "https://accounts.google.com"],
  });
  expect(signOutHosts([signedIn])).toEqual(["huji.ac.il", "openathens.net"]);
  // A host on the university's own site clears that site; any other host only itself, so a
  // library vendor's other customers keep their sessions.
  const vendor = row("acc_vendor", {
    sites: ["huji.ac.il", "https://idp.cc.huji.ac.il"],
    proxyUrl: "https://proxy.library-vendor.com/login?url={url}",
  });
  expect(signOutHosts([vendor])).toEqual(["proxy.library-vendor.com", "huji.ac.il"]);
  const legacy = row("acc_legacy", {
    sites: ["ezproxy.example.edu"],
    proxyUrl: "https://ezproxy.example.edu/login?url={url}",
  });
  expect(signOutHosts([legacy])).toEqual(["ezproxy.example.edu"]);
  const odd = row("acc_odd", {
    sites: ["https://login.microsoftonline.com"],
    proxyUrl: "https://go.openathens.net/redirector/google.com?url={url}",
    institution: { ...HUJI, domain: "accounts.google.com" },
  });
  expect(signOutHosts([odd])).toEqual(["openathens.net"]);
  // Another OpenAthens membership in the profile shares that session: it stays signed in.
  const other = row("acc_other", {
    sites: ["tau.ac.il"],
    proxyUrl: "https://go.openathens.net/redirector/tau.ac.il?url={url}",
  });
  expect(signOutHosts([signedIn], [other])).toEqual(["huji.ac.il"]);
});

it("lets copies of one membership, route and profile share one quiet check", () => {
  const first = row("acc_a", { institution: HUJI, username: "corcos@huji.ac.il" });
  const second = row("acc_b", { institution: HUJI, username: "Corcos@huji.ac.il" });
  const elsewhere = row("acc_c", {
    institution: HUJI,
    username: "corcos@huji.ac.il",
    profileId: "work",
  });
  expect(glanceKey(first)).toBe(glanceKey(second));
  expect(glanceKey(first)).not.toBe(glanceKey(elsewhere));
});
