/** The two pages behind the icon rail's Code review item. */
export type CodeReviewPage = "pull-requests" | "issues";

const STORAGE_KEY = "scient.codeReview.page";

/** The page the switch last showed, so Code review reopens it; pull requests until then. */
export function readCodeReviewPage(): CodeReviewPage {
  if (typeof window === "undefined") return "pull-requests";
  return window.localStorage.getItem(STORAGE_KEY) === "issues" ? "issues" : "pull-requests";
}

export function rememberCodeReviewPage(page: CodeReviewPage): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, page);
}
