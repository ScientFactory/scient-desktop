import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";

import { SettingsRow } from "../../components/settings/settingsLayout";

export function ScientGettingStartedSettingsRow() {
  return (
    <Link
      className="group block rounded-xl outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      to="/getting-started"
    >
      <SettingsRow
        description="Connect an AI and update your local preferences."
        title={
          <span className="inline-flex items-center gap-2.5 transition-colors group-hover:text-foreground/75">
            Getting started
            <ArrowRightIcon
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1"
            />
          </span>
        }
      />
    </Link>
  );
}
