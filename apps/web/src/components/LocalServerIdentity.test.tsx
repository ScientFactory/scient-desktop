import type { ServerLocalServerProcess } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalServerIdentity } from "./LocalServerIdentity";

const server: ServerLocalServerProcess = {
  id: "srv-1",
  pid: 5734,
  command: "bun",
  displayName: "Scient",
  args: "",
  ports: [5734],
  addresses: [],
  cwd: "/work/scient-desktop",
  isStoppable: true,
};

describe("LocalServerIdentity", () => {
  it("uses semantic theme colors on the browser home", () => {
    const markup = renderToStaticMarkup(<LocalServerIdentity server={server} tone="browser" />);

    expect(markup).toContain("text-foreground");
    expect(markup).toContain("text-muted-foreground");
    expect(markup).not.toContain("text-white");
  });
});
