import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useEffect } from "react";

import { readIssueListPreferences } from "~/components/issue/issueListPreferences";
import { readPullRequestListPreferences } from "~/components/pullRequest/pullRequestListPreferences";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useIssuesSupported, usePullRequestsSupported } from "~/state/environments";
import { type CodeReviewPage, rememberCodeReviewPage } from "./codeReviewPage";

/**
 * The pull-request and issue pages' title. Where both pages exist it is a switch between them, so
 * the icon rail needs one Code review item; the page keeps its heading for screen readers.
 * `headingOnly` keeps just that heading, for a header whose search has taken the title's place.
 */
export function CodeReviewTitle({
  current,
  headingOnly = false,
}: {
  readonly current: CodeReviewPage;
  readonly headingOnly?: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the shown page however it was reached (switch, link, palette, Back) so the rail's Code review reopens it
  useEffect(() => {
    rememberCodeReviewPage(current);
  }, [current]);
  const title =
    current === "pull-requests" ? (
      <T>Pull requests</T>
    ) : (
      <T context="page title, list of issues">Issues</T>
    );
  if (headingOnly) return <h1 className="sr-only">{title}</h1>;
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
          if (next === "issues") {
            void navigate({ to: "/issues", search: readIssueListPreferences() });
          } else if (next === "pull-requests") {
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
