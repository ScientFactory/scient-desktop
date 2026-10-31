import * as NodeEvents from "node:events";
import type { ClientRequest } from "electron";
import { expect, it } from "vite-plus/test";
import { isPublicHttps, quietVisit } from "./quietVisit.ts";

const fakeRequest = (act: (request: NodeEvents.EventEmitter) => void) => {
  const request = new NodeEvents.EventEmitter();
  let followed = 0;
  Object.assign(request, {
    end: () => act(request),
    abort: () => undefined,
    followRedirect: () => {
      followed++;
    },
  });
  return { open: () => request as unknown as ClientRequest, followed: () => followed };
};

it("follows a single sign-on bounce and reports where it ended", async () => {
  const fake = fakeRequest((request) => {
    request.emit("redirect", 302, "GET", "https://sso.example.com/start");
    request.emit("redirect", 302, "GET", "https://example.com/home");
    request.emit("response", { statusCode: 200 });
  });
  await expect(quietVisit(fake.open, "https://example.com/")).resolves.toEqual({
    url: "https://example.com/home",
    status: 200,
  });
  expect(fake.followed()).toBe(2);
});

it("stops at a redirect to a private address", async () => {
  const fake = fakeRequest((request) =>
    request.emit("redirect", 302, "GET", "https://192.168.1.1/"),
  );
  await expect(quietVisit(fake.open, "https://example.com/")).resolves.toEqual({
    url: "https://192.168.1.1/",
    status: 302,
  });
  expect(fake.followed()).toBe(0);
});

it("reports the answer, and nothing when the request fails", async () => {
  const answered = fakeRequest((request) => request.emit("response", { statusCode: 200 }));
  await expect(quietVisit(answered.open, "https://example.com/")).resolves.toEqual({
    url: "https://example.com/",
    status: 200,
  });
  const failed = fakeRequest((request) => request.emit("error", new Error("synthetic")));
  await expect(quietVisit(failed.open, "https://example.com/")).resolves.toBeNull();
});

it("stays on public HTTPS hosts", () => {
  expect(isPublicHttps("https://github.com/")).toBe(true);
  expect(isPublicHttps("http://github.com/")).toBe(false);
  expect(isPublicHttps("https://127.0.0.1:8443/")).toBe(false);
  expect(isPublicHttps("https://192.168.1.1/")).toBe(false);
  expect(isPublicHttps("https://printer.local/")).toBe(false);
  expect(isPublicHttps("https://localhost/")).toBe(false);
  expect(isPublicHttps("not a url")).toBe(false);
});
