import { expect, it, vi } from "vite-plus/test";

vi.mock("./accountsView", () => ({
  loadSourceProfiles: async () => [
    {
      id: "chrome",
      name: "Google Chrome",
      profiles: [
        {
          directory: "Profile 1",
          name: "Work",
          cookieCount: 812,
          email: "ada@example.com",
          picture: "data:image/png;base64,AAAA",
          color: "#123456",
          passwordCount: 40,
        },
      ],
    },
    { id: "safari", name: "Safari", profiles: [], unavailable: "notInstalled" },
  ],
}));

const { desktopSources } = await import("./desktopSources");

it("reads only what names a browser profile: never cookies, passwords or a picture", async () => {
  expect(await desktopSources()).toEqual([
    { browser: "chrome", directory: "Profile 1", name: "Work", email: "ada@example.com" },
  ]);
});
