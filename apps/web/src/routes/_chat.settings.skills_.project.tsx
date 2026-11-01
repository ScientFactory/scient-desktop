import { createFileRoute, redirect } from "@tanstack/react-router";

/** Skills moved into Extensions; old links land on the installed skills. */
export const Route = createFileRoute("/_chat/settings/skills_/project")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/extensions/installed",
      search: (current) => ({ ...current, kind: "skills" as const }),
      replace: true,
    });
  },
});
