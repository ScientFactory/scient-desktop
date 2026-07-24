import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT_ROUTE_SOURCE = FS.readFileSync(Path.join(import.meta.dirname, "__root.tsx"), "utf8");

describe("root startup surfaces", () => {
  it("keeps AppSnap available without mounting an unsolicited welcome dialog", () => {
    expect(ROOT_ROUTE_SOURCE).toContain("<AppSnapCoordinator />");
    expect(ROOT_ROUTE_SOURCE).not.toContain("AppSnapWelcomeDialog");
  });
});
