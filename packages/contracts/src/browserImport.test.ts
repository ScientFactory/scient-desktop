import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { DesktopPreviewImportCookiesInputSchema } from "./browserImport.ts";

const decodeImport = Schema.decodeSync(DesktopPreviewImportCookiesInputSchema);

it("carries the sites a refresh must leave alone across the desktop bridge", () => {
  const decoded = decodeImport({
    environmentId: "environment-fixture",
    sourceId: "chrome",
    sourceProfileDirectory: "Default",
    targetProfileId: "work",
    keepSites: ["google.com"],
  });
  expect(decoded.keepSites).toEqual(["google.com"]);
});
