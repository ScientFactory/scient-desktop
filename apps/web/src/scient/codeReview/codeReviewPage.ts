/** The two pages behind the icon rail's Code review item. */
export type CodeReviewPage = "pull-requests" | "issues";

const STORAGE_KEY = "scient.codeReview.page";

/** Kept for this session when the browser refuses storage, so navigation never depends on it. */
let sessionPage: CodeReviewPage = "pull-requests";

/** The page last shown, so Code review reopens it; pull requests until then. */
export function readCodeReviewPage(): CodeReviewPage {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "issues" || stored === "pull-requests") return stored;
  } catch {
    // Storage denied: the session's page stands.
  }
  return sessionPage;
}

export function rememberCodeReviewPage(page: CodeReviewPage): void {
  sessionPage = page;
  try {
    window.localStorage.setItem(STORAGE_KEY, page);
  } catch {
    // Storage denied or full: the session still remembers.
  }
}
