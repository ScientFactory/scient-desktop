import { createFileRoute } from "@tanstack/react-router";
import { CustomModelsPanel } from "~/components/settings/CustomModelsPanel";

export const Route = createFileRoute("/_chat/settings/custom-models")({
  component: CustomModelsPanel,
});
