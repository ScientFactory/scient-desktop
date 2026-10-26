import { expect, it } from "vite-plus/test";
import { groupSignedInSites } from "./signedInSites.ts";

it("groups subdomains using public and private suffixes and returns only domain counts", () => {
  expect(
    groupSignedInSites([
      { domain: ".mail.huji.ac.il" },
      { domain: "HUJI.AC.IL" },
      { domain: "a.user.github.io" },
      { domain: "user.github.io" },
      { domain: "other.github.io" },
      { domain: "localhost" },
      { domain: "127.0.0.1" },
      { domain: "" },
      { domain: "https://bad.test" },
    ]),
  ).toEqual([
    { domain: "huji.ac.il", cookies: 2 },
    { domain: "user.github.io", cookies: 2 },
    { domain: "127.0.0.1", cookies: 1 },
    { domain: "localhost", cookies: 1 },
    { domain: "other.github.io", cookies: 1 },
  ]);
});

it("caps the most frequent sites at fifty", () => {
  const cookies = Array.from({ length: 55 }, (_, index) => ({ domain: `site${index}.example` }));
  const result = groupSignedInSites([
    ...cookies,
    ...Array.from({ length: 3 }, () => ({ domain: "site54.example" })),
  ]);
  expect(result).toHaveLength(50);
  expect(result[0]).toEqual({ domain: "site54.example", cookies: 4 });
});
