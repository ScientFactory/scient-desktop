import { useNavigate } from "@tanstack/react-router";

import { requestConversationImport } from "../conversationImport/requests";
import { useCloudConversationsAvailable } from "../cloud/cloudConversationsAvailable";
import { feedbackAvailable } from "../feedback/FeedbackDialog";
import { requestFeedback } from "../feedback/feedbackStore";
import { useIssuesSupported, usePullRequestsSupported } from "../../state/environments";
import { readIssueListPreferences } from "../../components/issue/issueListPreferences";
import { readPullRequestListPreferences } from "../../components/pullRequest/pullRequestListPreferences";
import { useSidebar } from "../../components/ui/sidebar";

/** Where the sidebar's utility buttons lead; the footer row and the icon rail share them. */
export function useSidebarUtilityActions() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  // Conversations the person's computers copied to Scient Cloud.
  const cloudAvailable = useCloudConversationsAvailable();
  const canSendFeedback = feedbackAvailable();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return {
    closeMobileSidebar,
    pullRequestsSupported,
    issuesSupported,
    cloudAvailable,
    canSendFeedback,
    handlePullRequestsClick: () => {
      closeMobileSidebar();
      void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
    },
    handleIssuesClick: () => {
      closeMobileSidebar();
      void navigate({ to: "/issues", search: readIssueListPreferences() });
    },
    handleSettingsClick: () => {
      closeMobileSidebar();
      void navigate({ to: "/settings" });
    },
    handleImportClick: () => {
      closeMobileSidebar();
      requestConversationImport();
    },
    handleCloudClick: () => {
      closeMobileSidebar();
      void navigate({ to: "/cloud" });
    },
    handleFeedbackClick: () => {
      closeMobileSidebar();
      requestFeedback({ source: "sidebar" });
    },
    handleUsageClick: () => {
      closeMobileSidebar();
      void navigate({ to: "/usage" });
    },
  };
}
