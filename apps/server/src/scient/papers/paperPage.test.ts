import { expect, it } from "@effect/vitest";
import { pageState, pdfAddressFor, type PaperPage } from "./paperPage.ts";

const page = (fields: Partial<PaperPage>): PaperPage => ({
  url: "https://journals.sagepub.com/doi/10.1177/1",
  title: "An article",
  status: 200,
  pdf: false,
  pdfUrl: null,
  login: false,
  challenge: false,
  institutionUrl: null,
  buy: false,
  ...fields,
});

it("follows a PDF link even beside words that say the paper is for sale", () => {
  expect(pageState(page({ buy: true, pdfUrl: "https://a.org/x.pdf" }))).toEqual({
    state: "pdf-link",
    url: "https://a.org/x.pdf",
  });
});

it("reads a bot check as a bot check, never as a paywall", () => {
  expect(pageState(page({ title: "Just a moment...", challenge: true, status: 403 }))).toEqual({
    state: "bot-check",
  });
});

it("knows a university sign-in by its address when no password field shows yet", () => {
  for (const url of [
    "https://idp.cc.huji.ac.il/simplesaml/module.php/hujicc/login?AuthState=x",
    "https://sso.example.edu/adfs/ls/",
    "https://example.edu/cas/login",
    "https://login.microsoftonline.com/common/saml2",
  ])
    expect(pageState(page({ url }))).toEqual({ state: "sign-in" });
});

it("leaves refusal, a chooser, a sale and nothing at all apart", () => {
  expect(pageState(page({ status: 418 }))).toEqual({ state: "refused" });
  expect(pageState(page({ institutionUrl: "https://a.org/wayf" }))).toEqual({
    state: "institution",
    url: "https://a.org/wayf",
  });
  expect(pageState(page({ buy: true }))).toEqual({ state: "paywall" });
  expect(pageState(page({}))).toEqual({ state: "unclear" });
});

it("derives a PDF address from the article's own address", () => {
  expect(pdfAddressFor("https://journals.sagepub.com/doi/abs/10.1177/123")).toBe(
    "https://journals.sagepub.com/doi/pdf/10.1177/123?download=true",
  );
  expect(pdfAddressFor("https://onlinelibrary.wiley.com/doi/full/10.1002/x.1")).toBe(
    "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/x.1",
  );
  expect(pdfAddressFor("https://www.sciencedirect.com/science/article/pii/S09?via%3Dihub")).toBe(
    "https://www.sciencedirect.com/science/article/pii/S09/pdfft?isDTMRedirect=true&download=true",
  );
  expect(pdfAddressFor("https://www.science.org/doi/pdf/10.1126/x?download=true")).toBe(
    "https://www.science.org/doi/pdf/10.1126/x?download=true",
  );
  expect(pdfAddressFor("https://example.org/paper")).toBeUndefined();
});
