import { createFileRoute } from "@tanstack/react-router";

import { RepositoriesSettingsPanel } from "../components/settings/RepositoriesSettingsPanel";

export const Route = createFileRoute("/settings/repositories")({
  component: RepositoriesSettingsPanel,
});
