import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { readIssueListPreferences } from "~/components/issue/issueListPreferences";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useIssuesSupported, usePullRequestsSupported } from "~/state/environments";
import { type CodeReviewPage, rememberCodeReviewPage } from "./codeReviewPage";

/**
 * The pull-request and issue pages' title. Where both pages exist it is a switch between them, so
 * the icon rail needs one Code review item; the page keeps its heading for screen readers.
 */
export function CodeReviewTitle({ current }: { readonly current: CodeReviewPage }) {
  const gt = useGT();
  const navigate = useNavigate();
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const title =
    current === "pull-requests" ? (
      <T>Pull requests</T>
    ) : (
      <T context="page title, list of issues">Issues</T>
    );
  if (!pullRequestsSupported || !issuesSupported) return <h1 className="truncate">{title}</h1>;

  return (
    <>
      <h1 className="sr-only">{title}</h1>
      <ToggleGroup
        aria-label={gt("Code review")}
        className="shrink-0 [-webkit-app-region:no-drag]"
        value={[current]}
        onValueChange={(value) => {
          const next = value[0];
          if (next !== "pull-requests" && next !== "issues") return;
          rememberCodeReviewPage(next);
          if (next === "issues") {
            void navigate({ to: "/issues", search: readIssueListPreferences() });
          } else {
            void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
          }
        }}
      >
        <Toggle value="pull-requests">
          <T>Pull requests</T>
        </Toggle>
        <Toggle value="issues">
          <T context="page title, list of issues">Issues</T>
        </Toggle>
      </ToggleGroup>
    </>
  );
}
