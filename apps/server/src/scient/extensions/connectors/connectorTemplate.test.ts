// @effect-diagnostics nodeBuiltinImport:off -- Writes the shipped template to a scratch folder and imports it.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { connectorTemplate } from "./connectorTemplate.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const PORTAL = "https://portal.example.edu";

interface Sent {
  readonly url: string;
  readonly cookie: string;
  readonly authorization: string | null;
}

interface TemplateSession {
  readonly json: (path: string, init?: RequestInit) => Promise<unknown>;
}

/** The template's session helper as `scient_connector_copy` ships it, over a recording fetch. */
const sessionOver = async (
  cookies: ReadonlyArray<Record<string, unknown>>,
  answer: (url: URL) => { readonly status: number; readonly headers: Record<string, string> },
) => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-template-"));
  roots.push(root);
  for (const [path, text] of Object.entries(
    connectorTemplate({ name: "portal", displayName: "Portal" }),
  )) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, path), text);
  }
  const file = NodePath.join(root, "cookies.json");
  await NodeFSP.writeFile(file, JSON.stringify(cookies));
  const sent: Sent[] = [];
  const http = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    sent.push({
      url,
      cookie: headers.get("cookie") ?? "",
      authorization: headers.get("authorization"),
    });
    const reply = answer(new URL(url));
    return new Response("{}", {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  };
  const module = (await import(NodeURL.pathToFileURL(NodePath.join(root, "session.mjs")).href)) as {
    createSession: (options: unknown) => TemplateSession;
  };
  const session = module.createSession({
    http,
    env: { SCIENT_SIGN_IN_SITE: PORTAL, SCIENT_SIGN_IN_COOKIES: file },
  });
  return { session, sent };
};

const cookie = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  value: `${name}-value`,
  domain: "portal.example.edu",
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  ...extra,
});

const ok = { status: 200, headers: {} };

describe("the connector template's session helper", () => {
  it("drops Authorization and cookies on a redirect to another origin", async () => {
    const { session, sent } = await sessionOver([cookie("sid")], (url) =>
      url.pathname === "/go"
        ? { status: 302, headers: { location: "https://cdn.example.net/file" } }
        : ok,
    );
    await session.json("/go", { headers: { authorization: "Bearer portal-token" } });
    expect(sent[0]).toMatchObject({ authorization: "Bearer portal-token" });
    expect(sent[1]).toEqual({
      url: "https://cdn.example.net/file",
      cookie: "",
      authorization: null,
    });
  });

  it("sends a host-only cookie to its exact host only", async () => {
    const { session, sent } = await sessionOver(
      [cookie("host_only"), cookie("whole_domain", { domain: ".example.edu", hostOnly: false })],
      (url) =>
        url.pathname === "/set"
          ? { status: 200, headers: { "set-cookie": "fresh=1; Path=/" } }
          : ok,
    );
    await session.json("/set");
    await session.json("https://files.portal.example.edu/x");
    expect(sent[1]?.cookie).toBe("whole_domain=whole_domain-value");
  });

  it("scopes a cookie set without Path to the response's directory", async () => {
    const { session, sent } = await sessionOver([], (url) =>
      url.pathname === "/course/7/page"
        ? { status: 200, headers: { "set-cookie": "pathless=1" } }
        : ok,
    );
    await session.json("/course/7/page");
    await session.json("/course/7/other");
    await session.json("/elsewhere");
    expect(sent[1]?.cookie).toBe("pathless=1");
    expect(sent[2]?.cookie).toBe("");
  });
});
