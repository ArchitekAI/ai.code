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
