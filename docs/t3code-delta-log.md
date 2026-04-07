# T3 Code Delta Log

This file tracks repo behavior that intentionally differs from upstream `t3code`.

Use it as the first checklist when we:

- pull from upstream,
- debug a behavior that exists here but not in upstream,
- decide whether a local feature should stay fork-only or be upstreamed.

## How To Update This File

Add an entry whenever we introduce or materially change behavior that does not exist in upstream `t3code`.

For each entry, capture:

- what changed,
- why we changed it,
- the user context that led to the change,
- the main files involved,
- how risky it is to merge upstream changes into that area.

## Active Deltas

## 2026-04-06

### Linear issue lifecycle state transitions and PR notification

- Status: Local-only
- Merge risk: Medium
- User context: The user wanted Cyrus-style automatic issue state transitions so Linear issues move to "In Progress" when the agent starts working and to "In Review" when a PR is created, with PR link and Vercel preview URL included in the completion response.
- Why: Cyrus automatically moves issues to the lowest-position "started" workflow state when the agent begins. This fork now mirrors that behavior and extends it with an automatic "In Review" transition after PR creation, plus best-effort Vercel preview URL detection from GitHub PR checks.
- Behavior:
  - When a new Linear agent session is bootstrapped, the issue is moved to the lowest-position "started" workflow state (typically "In Progress") using the team's workflow state taxonomy, matching Cyrus's `moveIssueToStartedState` behavior.
  - When the Linear session completion reactor creates or opens a PR, the issue is moved to the highest-position "started" workflow state (typically "In Review"). If the team only has one "started" state, the transition is skipped.
  - After PR creation, a background task polls GitHub PR checks for Vercel deployment URLs and posts a follow-up "Preview deployment ready" activity if found.
  - The completion response now includes the PR link, branch name, and (when available) the Vercel preview URL.
  - Both state transitions are fire-and-forget: failures are logged as warnings and never block the primary session flow.
  - Comment steering during active execution works via the existing `handlePrompted` webhook handler, which dispatches user comments as new turns to the running provider session.
- Files:
  - `apps/server/src/linear/Services/LinearClient.ts` — added `LinearWorkflowState` type, `teamId` to issue details, `fetchTeamWorkflowStates` and `updateIssueState` methods
  - `apps/server/src/linear/Layers/LinearClient.ts` — implemented new Linear SDK methods
  - `apps/server/src/linear/Layers/LinearIssueLifecycle.ts` — new shared module for issue state transitions
  - `apps/server/src/linear/Layers/LinearWebhookHandler.ts` — calls `moveIssueToInProgress` on session start
  - `apps/server/src/linear/Layers/LinearSessionCompletionReactor.ts` — calls `moveIssueToReviewState` after PR creation, adds Vercel preview URL detection
  - `apps/server/src/linear/Layers/LinearWebhookHandler.test.ts` — updated mock with new client methods and teamId
  - `apps/server/src/server.test.ts` — updated mock with new client methods
- Notes: The "In Review" transition goes beyond Cyrus parity (Cyrus only does "In Progress"). The Vercel preview detection uses the `gh` CLI and is best-effort — it will silently no-op if `gh` is not available or if the repo has no Vercel integration.

### Cyrus-style Linear action/result feed formatting

- Status: Local-only
- Merge risk: Medium
- User context: The user compared Vevin against Jevin/Cyrus and found the Linear issue feed too vague. Vevin was emitting repetitive generic entries like "Running Ran command started..." instead of the richer action/result trail Cyrus shows.
- Why: The provider runtime already captured detailed command and MCP payloads, but the orchestration projection discarded that data before the Linear sink could format it. This fork now preserves the provider payload and formats Linear activities more like Cyrus.
- Behavior:
  - Tool lifecycle projections now retain the original provider payload for both `tool.started` and `tool.completed`.
  - The Linear activity sink now suppresses noisy command/tool progress churn and emits durable Cyrus-style action/result entries for completed command and MCP tool calls.
  - Command executions now render as `Bash` actions with the command as the parameter and command output as the result.
  - MCP tool calls now render with a humanized tool name plus a meaningful parameter/result extracted from tool arguments and structured output.
  - Reconnect-style transient warnings are dropped from the durable Linear timeline.
  - Plan updates now render as readable checklist-style thoughts instead of the generic `Plan updated` text.
  - Turn start now uses the Cyrus-style `Analyzing your request...` ephemeral banner.
- Files:
  - `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
  - `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
  - `apps/server/src/linear/Layers/LinearActivityFormatter.ts`
  - `apps/server/src/linear/Layers/LinearActivitySink.ts`
  - `apps/server/src/linear/Layers/LinearActivitySink.test.ts`
- Notes: This intentionally prefers a smaller number of high-signal durable activities over raw provider churn in the Linear issue feed, matching Cyrus behavior more closely than the earlier fork implementation.

### Cyrus-style Linear session completion guidance and stop responses

- Status: Local-only
- Merge risk: Medium
- User context: The user wanted the Linear agent flow to behave much more like Cyrus, especially around orchestration discipline, final responses in Linear, and PR creation before an agent session ends.
- Why: This fork now adds explicit Linear response activities for stop/terminal session exits and appends shared verify-and-ship guidance to the Linear system prompts so code-changing sessions are pushed toward verification, PR creation, and a final Linear-ready summary.
- Behavior:
  - Prompted stop requests, terminal workflow-state transitions, and unassignment now post a durable Linear `response` activity before the thread is interrupted and stopped.
  - Completed Linear-backed turns now run through a backend completion reactor that inspects git state, performs `commit_push_pr` or `create_pr` when needed, and posts a single durable final `response` activity that includes the PR URL.
  - The completion reactor now treats both `ready` and `stopped` Linear sessions as valid completion candidates so fast session teardown still gets the same shipping and final-response behavior Cyrus enforces with its stop hook.
  - Builder, debugger, orchestrator, and graphite-orchestrator prompts now include a shared workflow extension that requires acceptance-criteria validation, project checks, PR creation or update, and a concise final summary when code changes are made.
  - Orchestrator prompts now explicitly treat shipping and PR status as part of verification, not optional follow-up.
- Files:
  - `apps/server/src/linear/Layers/LinearWebhookHandler.ts`
  - `apps/server/src/linear/Layers/LinearSessionCompletionReactor.ts`
  - `apps/server/src/linear/Layers/LinearSessionCompletionReactor.test.ts`
  - `apps/server/src/linear/Layers/LinearPromptAssembler.ts`
  - `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`
  - `apps/server/src/linear/Layers/LinearWebhookHandler.test.ts`
  - `apps/server/src/linear/prompts/builder.md`
  - `apps/server/src/linear/prompts/orchestrator.md`
  - `apps/server/src/linear/prompts/graphite-orchestrator.md`
  - `apps/server/src/linear/prompts/verify-and-ship-system-prompt-extension.md`
- Notes: This still does not fully reproduce Cyrus stop-hook enforcement because the current provider stack does not expose the same stop-hook mechanism. The fork now matches Cyrus more closely through explicit Linear lifecycle responses and stronger prompt-level shipping requirements.

### Linear agent timeline defaults to durable entries instead of ephemeral replacements

- Status: Local-only
- Merge risk: Medium
- User context: The user noticed that Linear agent updates were replacing the previous activity instead of building a readable execution log, making it hard to follow what the agent had done.
- Why: Cyrus only uses ephemeral Linear activities for short-lived status banners like "Analyzing your request…" and keeps the actual work log durable. This fork now follows that model so Linear shows a running history instead of a single constantly replaced item.
- Behavior:
  - Tool progress, task progress, approvals, warnings, plan updates, user-input waits, and diff summaries now post as durable activities.
  - `thread.turn-start-requested` still uses an ephemeral "Starting work..." status, preserving the transient banner behavior Cyrus uses for session startup.
- Files:
  - `apps/server/src/linear/Layers/LinearActivitySink.ts`
  - `apps/server/src/linear/Layers/LinearActivitySink.test.ts`
- Notes: Upstream merges touching Linear activity projection should be reviewed carefully, because the ephemeral policy now intentionally mirrors Cyrus rather than the fork's earlier "replace the last item" behavior.

## 2026-04-05

### Managed repo onboarding writes Linear routing settings and creates T3 projects

- Status: Local-only
- Merge risk: Medium
- User context: The user wanted Cyrus-style repo onboarding parity, but with one fork-specific twist: once a repo is cloned and registered for Linear routing, it should also appear as a normal T3 Code project automatically.
- Why: Upstream `t3code` does not have a managed repo onboarding flow. This fork now lets the server clone a Git repo, detect its base branch, persist the Linear routing/base-branch metadata in settings, and create the corresponding T3 project in one operation.
- Behavior:
  - `projects.add` is now a first-class websocket RPC for onboarding Git repositories.
  - The onboarding flow clones repos into the managed server repo directory, detects the default remote base branch, and persists or updates the matching `linearProjectMappings` entry in server settings.
  - Adding a repository now also ensures a T3 project exists for that checkout, so the repo becomes available in both Linear routing and the normal T3 project list immediately.
  - The sidebar add-project entry now accepts either a local workspace path or a Git repository URL; Git URLs take the managed onboarding path instead of the local `project.create` shortcut.
- Files:
  - `packages/contracts/src/project.ts`
  - `packages/contracts/src/ipc.ts`
  - `packages/contracts/src/rpc.ts`
  - `apps/server/src/project/Services/ProjectOnboarding.ts`
  - `apps/server/src/project/Layers/ProjectOnboarding.ts`
  - `apps/server/src/server.ts`
  - `apps/server/src/ws.ts`
  - `apps/server/src/linear/Layers/LinearWebhookHandler.ts`
  - `apps/server/src/server.test.ts`
  - `apps/web/src/wsRpcClient.ts`
  - `apps/web/src/wsNativeApi.ts`
  - `apps/web/src/wsNativeApi.test.ts`
  - `apps/web/src/components/Sidebar.tsx`
- Notes: Repo availability is still settings-driven rather than DB-driven, so this is parity with Cyrus’s managed config model, not a replacement for it. Future upstream merges touching project creation, workspace routing, or sidebar add-project UX will need a careful review.

### Cyrus-style Linear OAuth self-hosting flow

- Status: Local-only
- Merge risk: High
- User context: The user wanted this fork to match the real Cyrus self-hosting behavior and explicitly asked that `.cyrus-ref` be treated as the primary parity reference instead of using a simplified direct-token-only Linear setup.
- Why: Upstream `t3code` has no Cyrus-style Linear OAuth app install flow. This fork now supports the same environment model and callback flow Cyrus uses for self-hosted Linear installs.
- Behavior:
  - The server now understands Cyrus-style Linear env names, including `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_DIRECT_WEBHOOKS`, and `CYRUS_BASE_URL`.
  - Linear OAuth credentials can now be installed through HTTP routes instead of only through a pre-seeded API token.
  - `GET /oauth/authorize` redirects to Linear's OAuth app authorization page using the Cyrus-compatible actor/scopes payload.
  - `GET /callback` exchanges the authorization code, fetches the authorized workspace metadata, and persists the installed workspace token/refresh token into server settings.
  - The Linear client now falls back to the installed OAuth workspace token when no direct API token is configured and refreshes the token when Linear returns an auth failure.
  - The server now accepts Cyrus-compatible Linear webhook delivery on both `POST /webhook` and `POST /webhook/linear`.
- Files:
  - `AGENTS.md`
  - `apps/server/src/cli.ts`
  - `apps/server/src/server.ts`
  - `apps/server/src/server.test.ts`
  - `apps/server/src/cli-config.test.ts`
  - `apps/server/src/linear/Layers/LinearOAuth.ts`
  - `apps/server/src/linear/Layers/LinearOAuth.test.ts`
  - `apps/server/src/linear/Layers/LinearOAuthRoute.ts`
  - `apps/server/src/linear/Layers/LinearWebhookRoute.ts`
  - `apps/server/src/linear/Layers/LinearClient.ts`
  - `apps/server/src/linear/Services/LinearOAuth.ts`
  - `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`
  - `packages/contracts/src/linear.ts`
  - `packages/contracts/src/settings.ts`
- Notes: This is a deep fork divergence because startup config, persisted settings, Linear client auth, and HTTP route assembly all now depend on Cyrus parity assumptions. Upstream merges touching Linear runtime config, settings schemas, or route composition will need careful review.

### T3 MCP child-orchestration mode for Linear sessions

- Status: Local-only
- Merge risk: High
- User context: The user wanted Phase 1 of the Cyrus-style orchestrator mode plan implemented, including first-party MCP helpers, label-driven prompt modes, child session delegation, and parent verification flows inside T3 Code.
- Why: Upstream `t3code` does not ship the fork-specific MCP surface or parent/child thread orchestration needed to run Linear-driven orchestrator workflows end to end.
- Behavior:
  - Linear-triggered worktrees now receive three MCP servers by default: hosted `linear`, local `t3-tools`, and local `t3-docs`.
  - The server now exposes `/mcp/t3-tools` and `/mcp/t3-docs` endpoints so orchestrator prompts can create child Linear sessions, relate issues, upload files, search repo docs, and fetch project documentation without external Cyrus services.
  - Parent/child thread relationships are persisted so a child completion or child-session failure can resume the parent thread with the child worktree mounted as an additional directory for verification.
  - Linear prompt routing now supports `builder`, `debugger`, `scoper`, `orchestrator`, and `graphite-orchestrator`, including prompt-mode entry activity and prompt-type-specific tool allow/deny policy.
  - Builder/debugger prompts now carry the Cyrus-style task-first guidance, while scoper/orchestrator modes append the shared todo-management extension so planning and verification instructions stay consistent across prompt types.
  - Scoper now behaves more like a durable specification workflow, including Linear-document-oriented guidance and stricter non-implementation instructions, while builder/debugger now carry a closer Cyrus-style execution flow for reconnaissance, planning, and verification.
  - `t3-docs` now indexes both fork docs and the Linear prompt templates so background sessions can inspect the local orchestration guidance they are expected to follow.
  - Linear project mappings now carry repo routing aliases, project keys, routing labels, prompt labels, and tool-policy metadata so repo selection, prompt selection, and tool access resolve from the same source of truth.
- Files:
  - `apps/server/src/mcp/t3Tools.ts`
  - `apps/server/src/mcp/t3Docs.ts`
  - `apps/server/src/mcp/Layers/McpToolsRoute.ts`
  - `apps/server/src/mcp/Layers/McpDocsRoute.ts`
  - `apps/server/src/mcp/Layers/ChildCompletionReactor.ts`
  - `apps/server/src/mcp/Layers/McpContextRegistry.ts`
  - `apps/server/src/mcp/Layers/ThreadRelationshipRegistry.ts`
  - `apps/server/src/linear/Layers/LinearWebhookHandler.ts`
  - `apps/server/src/linear/Layers/LinearActivitySink.ts`
  - `apps/server/src/linear/Layers/LinearPromptAssembler.ts`
  - `apps/server/src/linear/prompts/scoper.md`
  - `apps/server/src/linear/prompts/graphite-orchestrator.md`
  - `apps/server/src/linear/prompts/todolist-system-prompt-extension.md`
  - `apps/server/src/provider/Layers/ToolPolicyResolver.ts`
  - `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`
  - `packages/contracts/src/linear.ts`
  - `packages/contracts/src/orchestration.ts`
  - `packages/contracts/src/provider.ts`
  - `packages/contracts/src/settings.ts`
- Notes: This delta adds new persisted state, local MCP HTTP routes, and prompt/tool-policy coupling that upstream does not know about. Merges touching Linear webhook handling, provider startup, or route assembly will need extra review.

### Linear agent "brain" parity and provider-agnostic session context

- Status: Local-only
- Merge risk: High
- User context: The user wanted Cyrus-style Linear agent orchestration in this fork, including rich issue context, better activity streaming, Linear MCP access, and lifecycle cleanup. During implementation, they explicitly pushed back on a Codex-only solution and asked that Claude be supported too.
- Why: Linear-triggered sessions were previously little more than webhook plumbing. The fork now assembles a real task context, injects Linear tooling into the worktree, and keeps Linear users informed while work is happening.
- Behavior:
  - New Linear sessions build an enriched prompt from issue metadata, comment threads, repository/worktree context, and optional Linear agent guidance instead of sending only the bare issue description.
  - Linear label selection chooses a fork-local system prompt template (`builder`, `debugger`, `orchestrator`) modeled after Cyrus. The selected prompt prefix is threaded through the provider turn flow for both Codex and Claude-backed sessions.
  - Linear-triggered worktrees now receive Linear MCP configuration on disk so the agent can query and update Linear from inside the session. The config is mirrored to both `.mcp.json` and `.codex/mcp.json` so Claude-style and Codex-style project config discovery both work.
  - When Linear issue metadata cannot be routed to a configured repository, the webhook handler now mirrors Cyrus by posting a `select` agent activity asking which repository to use and defers thread bootstrap until the follow-up `agentSessionPrompted` webhook arrives.
  - Linear activity syncing now forwards structured orchestration activity updates, richer session lifecycle messages, and diff stats instead of only sparse start/finish events.
  - Linear `Issue` update webhooks now stop active sessions when an issue reaches a terminal state and send a follow-up turn when the issue title or description changes mid-flight.
- Files:
  - `apps/server/src/linear/Layers/LinearPromptAssembler.ts`
  - `apps/server/src/linear/Services/LinearPromptAssembler.ts`
  - `apps/server/src/linear/prompts/builder.md`
  - `apps/server/src/linear/prompts/debugger.md`
  - `apps/server/src/linear/prompts/orchestrator.md`
  - `apps/server/src/linear/Layers/LinearWebhookHandler.ts`
  - `apps/server/src/linear/Layers/LinearWebhookHandler.test.ts`
  - `apps/server/src/linear/Layers/LinearActivitySink.ts`
  - `apps/server/src/linear/Layers/LinearClient.ts`
  - `apps/server/src/linear/Services/LinearClient.ts`
  - `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`
  - `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
  - `apps/server/src/orchestration/decider.ts`
  - `apps/server/src/provider/Layers/CodexAdapter.ts`
  - `apps/server/src/provider/Layers/ClaudeAdapter.ts`
  - `apps/server/src/codexAppServerManager.ts`
  - `packages/contracts/src/linear.ts`
  - `packages/contracts/src/orchestration.ts`
  - `packages/contracts/src/provider.ts`
- Notes: This is the deepest fork divergence in the current Linear integration and it crosses orchestration, provider dispatch, and prompt shaping. Upstream merges in these areas will need especially careful conflict resolution because the fork now depends on provider-agnostic system prompt threading and worktree-local MCP setup.

## 2026-04-04

### Linear webhook ingress for agent sessions

- Status: Local-only
- Merge risk: Medium
- User context: The user wanted T3 Code to react to Linear agent-session webhooks so assigning work in Linear can create or continue a coding session without manually starting from the UI.
- Why: This fork now supports Linear-driven agent ingress, session tracking, and outbound Linear activity updates while reusing the existing orchestration engine and worktree bootstrap flow.
- Behavior:
  - `POST /webhook/linear` verifies Linear webhooks and maps supported events into orchestration commands.
  - Linear assignment / prompt events can create a project, create a worktree-backed thread, continue an existing thread for the same issue, or stop a running thread.
  - Linear-linked threads stream assistant progress back to Linear as agent activities.
- Files:
  - `packages/contracts/src/linear.ts`
  - `packages/contracts/src/settings.ts`
  - `apps/server/src/linear/Layers/LinearWebhookRoute.ts`
  - `apps/server/src/linear/Layers/LinearWebhookHandler.ts`
  - `apps/server/src/linear/Layers/LinearActivitySink.ts`
  - `apps/server/src/linear/Layers/LinearSessionRegistry.ts`
  - `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`
  - `apps/server/src/persistence/Migrations/020_LinearSessions.ts`
- Notes: The fork adds persistent Linear session mappings in SQLite and environment-backed Linear settings overrides at startup. Upstream merges touching server startup, orchestration bootstrap, or settings decoding will need extra care.

### Project deletion cascades through project threads

- Status: Local-only
- Merge risk: Low
- User context: The user wanted project removal to delete project threads too, but specifically asked for an approach that would not create merge conflicts when pulling upstream changes, then asked to implement that approach.
- Why: Removing a project in this repo now deletes that project's threads instead of blocking with a warning.
- Behavior: The web app confirms once, deletes each thread with the existing thread deletion flow, then dispatches project deletion.
- Files:
  - `apps/web/src/components/Sidebar.tsx`
  - `apps/web/src/lib/deleteProjectCascade.ts`
  - `apps/web/src/lib/deleteProjectCascade.test.ts`
- Notes: This was intentionally implemented in the web layer instead of adding a new orchestration command, so it should be easier to preserve across upstream pulls.

### Fork-local desktop install/update workflow and app identity

- Status: Local-only
- Merge risk: Medium
- User context: The user wanted a one-command way to pull, build, install, and replace the locally installed desktop app from this fork, and wanted the fork to have a different app name so it can live separately from upstream T3 Code in the Dock.
- Why: This repo now has a local install workflow optimized for using the fork as an everyday app instead of only as a dev environment.
- Behavior: `bun run dist:install` pulls the current branch, installs dependencies, builds a macOS `.app`, replaces the installed app, and reopens it. The desktop builder also supports fork-specific product name and app id overrides so the installed app can appear as a separate Dock app.
- Files:
  - `package.json`
  - `scripts/build-desktop-artifact.ts`
  - `scripts/install-local-desktop.ts`
  - `apps/desktop/src/main.ts`
- Notes: The install script defaults to the app name `AI Code` and app id `com.t3tools.aicode`, but both can be overridden with environment variables or script flags.

### Remote runtime mode (`--mode remote`)

- Status: Local-only
- Merge risk: Low
- User context: The user wanted to run the T3 Code server on a remote cloud machine and connect from a local browser, but several features assumed co-located client and server.
- Why: A new `remote` runtime mode disables features that only work when client and server share a machine, and sets network defaults appropriate for remote access.
- Behavior: `t3 --mode remote` (or `T3CODE_MODE=remote`) applies these defaults:
  - Binds to `0.0.0.0` (all interfaces) instead of localhost.
  - Disables browser auto-open (`noBrowser: true`).
  - Disables `shellOpenInEditor` RPC — returns `OpenError` explaining the feature is unavailable.
  - Returns empty `availableEditors` in server config so the client hides editor buttons.
  - All other features (terminal, git, diffs, orchestration) work unchanged over the network.
- Files:
  - `apps/server/src/config.ts` — extended `RuntimeMode` union with `"remote"`
  - `apps/server/src/cli.ts` — remote-mode defaults for host, noBrowser
  - `apps/server/src/ws.ts` — gates `shellOpenInEditor` and `availableEditors` on mode
- Notes: The desktop folder picker (`desktop:pick-folder`) was already gated behind `isElectron` on the client and returns `null` in web browsers, so no change was needed there. The client auto-detects the WebSocket URL from `window.location.origin`, so pointing a browser at `https://remote-host:3773` works out of the box.

### Collapsible project sidebar with Cmd+B keybinding

- Status: Local-only
- Merge risk: Low
- User context: The user couldn't collapse the project sidebar on desktop — the toggle button was hidden (`md:hidden`) and no keyboard shortcut existed.
- Why: The sidebar toggle button is now visible on desktop in the chat header, and `Cmd+B` / `Ctrl+B` toggles the sidebar via the existing keybinding system.
- Behavior: The `SidebarTrigger` in the sidebar header was removed (toggle lives only in the chat header). A new `sidebar.toggle` keybinding command was added, defaulting to `mod+b`, handled in `AppSidebarLayout.tsx` via a `SidebarKeyboardShortcuts` component inside the left `SidebarProvider`. The `SidebarTrigger` icon now correctly reflects desktop open/collapsed state.
- Files:
  - `packages/contracts/src/keybindings.ts` — added `sidebar.toggle` command
  - `apps/server/src/keybindings.ts` — added `mod+b` default binding
  - `apps/web/src/components/AppSidebarLayout.tsx` — handles `sidebar.toggle` via keybinding system
  - `apps/web/src/components/ui/sidebar.tsx` — fixed trigger icon state
  - `apps/web/src/components/chat/ChatHeader.tsx` — removed `md:hidden` from trigger
  - `apps/web/src/components/Sidebar.tsx` — removed trigger from sidebar header
- Notes: The handler lives in `AppSidebarLayout` (not `ChatView`) so it works on all routes, not just when a thread is active. It uses capture-phase event listening so the shortcut works even when the Lexical composer editor has focus. Uses the same keybinding system as `diff.toggle` (`mod+d`), so it supports server-side reconfiguration. The server auto-syncs the new default binding to existing config files on startup.

### Hide raw command churn from the T3 work log

- Status: Local-only
- Merge risk: Low
- User context: The user wanted Vevin's visible activity trail to feel much closer to Jevin/Cyrus. Raw `Ran command` rows made the work log noisy even when the underlying orchestration and shipping flow succeeded.
- Why: Command-by-command shell output is still useful for internal orchestration, but it makes the user-facing work log much noisier than Cyrus's higher-signal issue/session timeline.
- Behavior: The web work log now drops `command_execution` tool lifecycle rows while keeping plans, file changes, MCP/tool milestones, and terminal responses visible.
- Files:
  - `apps/web/src/session-logic.ts`
  - `apps/web/src/session-logic.test.ts`
- Notes: This only changes presentation. The underlying activities are still persisted for debugging and server-side orchestration.

### Keep runtime MCP auth files out of shipped commits

- Status: Local-only
- Merge risk: Medium
- User context: Vevin was creating valid commits locally, but GitHub push protection blocked branch pushes because runtime-generated `.mcp.json` files with Linear OAuth tokens were getting staged and committed.
- Why: Self-hosted Linear sessions need runtime MCP auth material inside the worktree so Codex can talk back to Linear, but those files must never become part of the repo diff or PR branch.
- Behavior: Commit preparation now always filters `.mcp.json` and `.codex/mcp.json` out of staged changes, even when staging specific paths. Linear bootstrap also writes those runtime files into `.git/info/exclude` so normal git status/add flows keep treating them as ignored noise.
- Files:
  - `apps/server/src/git/Layers/GitCore.ts`
  - `apps/server/src/git/Layers/GitCore.test.ts`
  - `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`
- Notes: This adapts Cyrus's "runtime auth is operational state, not repo state" behavior to T3 Code's worktree bootstrap path.

### Let Linear completion settle even if the provider session is still marked running

- Status: Local-only
- Merge risk: Medium
- User context: Vevin could finish the turn and generate the final assistant message, but Linear sometimes stayed stuck on `Working` with no terminal response, commit, push, or PR because the provider session status lagged behind.
- Why: T3 Code's Linear completion reactor previously waited for a completed turn _and_ a terminal session status (`ready` or `stopped`). Under real provider timing, the completed turn can arrive before the session transitions out of `running`.
- Behavior: Once the latest turn is completed, the Linear completion reactor now treats `running`, `ready`, and `stopped` session states as eligible for the terminal shipping pass. The resulting response/commit/PR flow now runs from the completed turn instead of silently stalling on status lag.
- Files:
  - `apps/server/src/linear/Layers/LinearSessionCompletionReactor.ts`
- Notes: This is intentionally more tolerant than upstream T3 Code because Cyrus treats the completed turn as the source of truth for terminal issue activity.

### Tolerate missing Linear prompted-webhook activity IDs

- Status: Local-only
- Merge risk: Low
- User context: Prompted Linear webhooks could fail schema validation in production because some payloads omitted the activity ID field, which prevented follow-up actions from being processed.
- Why: Real Linear prompted payloads are looser than our original contract schema.
- Behavior: The prompted webhook schema now accepts a missing `id` field and defaults it to an empty string so routing logic can continue handling the response.
- Files:
  - `packages/contracts/src/linear.ts`
- Notes: This keeps the webhook contract aligned with observed Linear payloads and the Cyrus-style "best effort prompt recovery" behavior.
