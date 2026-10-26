import { describe, expect, it } from "vite-plus/test";
import { classifyProfilePage } from "./profileClassification.ts";
import type { ProfileDetection } from "./profileDetection.ts";

const url = "https://docs.example.com/sheet";
const page: ProfileDetection = {
  finalUrl: url,
  title: "Sheet",
  passwordField: false,
  deniedText: false,
};

describe("browser profile page classification", () => {
  it.each([
    { name: "requested host", page, result: "opens" },
    {
      name: "requested subdomain",
      page: { ...page, finalUrl: "https://view.docs.example.com/sheet" },
      result: "opens",
    },
    {
      name: "Google sign-in redirect",
      page: { ...page, finalUrl: "https://accounts.google.com/ServiceLogin" },
      result: "sign-in",
    },
    {
      name: "Microsoft sign-in redirect",
      page: { ...page, finalUrl: "https://login.microsoftonline.com/tenant" },
      result: "sign-in",
    },
    {
      name: "other host sign-in path",
      page: { ...page, finalUrl: "https://identity.example.com/sso/start" },
      result: "sign-in",
    },
    { name: "visible password field", page: { ...page, passwordField: true }, result: "sign-in" },
    {
      name: "denial text takes priority over a login form",
      page: { ...page, passwordField: true, deniedText: true },
      result: "denied",
    },
    { name: "failed inspection", page: undefined, result: "error" },
    { name: "invalid requested URL", requested: "invalid", page, result: "error" },
    { name: "invalid final URL", page: { ...page, finalUrl: "invalid" }, result: "error" },
    {
      name: "insecure final URL",
      page: { ...page, finalUrl: "http://docs.example.com/sheet" },
      result: "error",
    },
    {
      name: "final URL with credentials",
      page: { ...page, finalUrl: "https://synthetic@docs.example.com/sheet" },
      result: "error",
    },
    {
      name: "lookalike host is not a subdomain",
      page: { ...page, finalUrl: "https://docs.example.com.attacker.test/sheet" },
      result: "error",
    },
  ])("$name", ({ requested, page, result }) => {
    expect(classifyProfilePage(requested ?? url, page)).toBe(result);
  });
});
