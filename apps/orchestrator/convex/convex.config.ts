import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config.js";

// The agent component will own orchestration state once later slices add model calls.
const app: any = defineApp();

app.use(agent);

export default app;
