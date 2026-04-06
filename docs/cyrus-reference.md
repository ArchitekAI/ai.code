# Cyrus Implementation Reference

> A reference for porting cyrus's background agent orchestration to T3 Code.
> Use as a checklist: each section maps to a capability that T3 Code needs to replicate.
> Go to .cyrus-ref folder for exact code implementation

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Webhook Ingress](#2-webhook-ingress)
3. [Repository Routing](#3-repository-routing)
4. [Prompt Assembly](#4-prompt-assembly)
5. [System Prompt Templates](#5-system-prompt-templates)
6. [Runner Selection & Adapters](#6-runner-selection--adapters)
7. [MCP Tool Configuration](#7-mcp-tool-configuration)
8. [Custom MCP Tools (cyrus-tools)](#8-custom-mcp-tools-cyrus-tools)
9. [Activity Sink & Posting](#9-activity-sink--posting)
10. [Session Management](#10-session-management)
11. [Orchestrator Mode](#11-orchestrator-mode)
12. [Worktree Management](#12-worktree-management)
13. [Issue Lifecycle Handlers](#13-issue-lifecycle-handlers)
14. [User Access Control](#14-user-access-control)
15. [Configuration Schema](#15-configuration-schema)
16. [Slack Integration](#16-slack-integration)
17. [Interactive User Questions](#17-interactive-user-questions-askuserquestion)
18. [Streaming / Mid-Implementation Prompts](#18-streaming--mid-implementation-prompts)
19. [Attachment Handling](#19-attachment-handling)
20. [WorktreeIncludeService](#20-worktreeincludeservice)
21. [Tool Permission System](#21-tool-permission-system)
22. [Graphite Stacking Workflows](#22-graphite-stacking-workflows)
23. [Session Persistence & Recovery](#23-session-persistence--recovery)
24. [GitHub Token Resolution](#24-github-token-resolution)
25. [Parity Checklist](#25-parity-checklist)

---

## 1. Architecture Overview

Cyrus is a multi-platform agent orchestrator. A single `EdgeWorker` process:

- Receives webhooks from Linear, GitHub, GitLab, and Slack
- Routes issues to the correct repository (6-priority routing)
- Assembles rich prompts (issue context, comments, guidance, system prompt)
- Injects MCP tools (Linear API, custom orchestration tools, Slack)
- Spawns agent runners (Claude, Codex, Cursor, Gemini)
- Streams activities back to Linear in real-time
- Tracks parent-child sessions for orchestrator workflows

**T3 Code equivalent mapping:**

| Cyrus Component            | T3 Code Equivalent                                 |
| -------------------------- | -------------------------------------------------- |
| EdgeWorker                 | `apps/server/` (server process)                    |
| LinearEventTransport       | `linear/Layers/LinearWebhookHandler.ts`            |
| RepositoryRouter           | `resolveMapping()` in LinearWebhookHandler         |
| PromptBuilder              | `linear/Layers/LinearPromptAssembler.ts` (Phase 0) |
| AgentSessionManager        | Orchestration engine + ProviderService             |
| ClaudeRunner / CodexRunner | CodexAdapter / ClaudeAdapter                       |
| GlobalSessionRegistry      | LinearSessionRegistry + ThreadRelationshipRegistry |
| ActivityPoster             | LinearActivitySink                                 |
| McpConfigService           | BootstrapTurnService (MCP config in worktree)      |

---

## 2. Webhook Ingress

### 2.1 Linear Webhooks

| Webhook Type          | Action                    | Cyrus Handler                           | Behavior                                                                    |
| --------------------- | ------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `AgentSessionEvent`   | `created`                 | `handleAgentSessionCreated()`           | Route to repo → create worktree → assemble prompt → start runner            |
| `AgentSessionEvent`   | `prompted`                | `handleAgentSessionPrompted()`          | 3 branches: stop signal / repo selection response / continue session        |
| `AppUserNotification` | `issueUnassignedFromYou`  | `handleIssueUnassigned()`               | Stop all runners → cleanup sessions                                         |
| `Issue`               | `update` (state change)   | `handleIssueStateChangeMessage()`       | If terminal state (Done/Canceled) → stop sessions → delete worktrees        |
| `Issue`               | `update` (content change) | `handleIssueTitleOrDescriptionUpdate()` | Detect changed fields via `updatedFrom` → inject update into active session |
| `Issue`               | `delete`                  | `handleIssueDeleted()`                  | Stop sessions → cleanup                                                     |
| `IssueComment`        | `create` (root)           | `handleNewRootComment()`                | Build continuation prompt → resume session                                  |

### 2.2 GitHub Webhooks

| Event                         | Cyrus Handler           | Behavior                                                         |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `issue_comment`               | `handleGitHubWebhook()` | PR comment → create worktree for branch → run agent → post reply |
| `pull_request_review_comment` | `handleGitHubWebhook()` | Inline review comment → route to session → respond               |
| `pull_request_review`         | `handleGitHubWebhook()` | Review submission (changes_requested) → respond                  |

### 2.3 Slack Webhooks

| Event         | Cyrus Handler          | Behavior                                                    |
| ------------- | ---------------------- | ----------------------------------------------------------- |
| `app_mention` | `handleSlackWebhook()` | Chat-style session (no issue) → run agent → reply in thread |

### 2.4 GitLab Webhooks

| Event      | Cyrus Handler           | Behavior                                              |
| ---------- | ----------------------- | ----------------------------------------------------- |
| Note on MR | `handleGitLabWebhook()` | MR comment → create worktree → run agent → post reply |

---

## 3. Repository Routing

**File:** `.cyrus-ref/packages/edge-worker/src/RepositoryRouter.ts`

### 3.1 Priority Order (first match wins)

| Priority | Method               | Source                                                     | Example                        |
| -------- | -------------------- | ---------------------------------------------------------- | ------------------------------ |
| 0        | Active session cache | Issue already routed                                       | Reuse cached repo for issue    |
| 1        | Description tags     | `[repo=name]` or `[repo=name#branch]` in issue description | `[repo=myorg/backend#develop]` |
| 2        | Routing labels       | Issue labels matched against `repo.routingLabels` config   | Label "backend" → backend repo |
| 3        | Project-based        | Issue's Linear project matched against `repo.projectKeys`  | Project "API" → api repo       |
| 4        | Team-based           | Issue's Linear team matched against `repo.teamKeys`        | Team "BE" → backend repo       |
| 5        | Team prefix          | Issue identifier prefix (e.g., `BE-123` → `BE`)            | `BE` prefix → backend repo     |
| 6        | Catch-all            | Repo with no routing config                                | First unfiltered repo          |

### 3.2 Description Tag Syntax

```
[repo=repo-name]                    → Route to repo by name
[repo=org/repo-name]                → Route by GitHub URL suffix
[repo=repo-name#develop]            → Route with base branch override
repos=frontend,backend              → Multi-repo (comma-separated)
[repo=frontend] [repo=backend]      → Multi-repo (separate tags)
```

**Parsing regex:**

- Bracketed: `/\\?\[repo=([a-zA-Z0-9_\-/.#]+)\\?\]/g`
- Unbracketed: `/(?:^|[\s\n])repos?=([a-zA-Z0-9_\-/.#,]+)/gm`

### 3.3 No Match → User Elicitation

When no routing rule matches, cyrus posts a Linear `select` signal asking the user to pick from available repos. The selection is stored in `pendingSelections` and resolved when the next `prompted` webhook arrives.

### 3.4 Repository Caching

Once a repository is selected for an issue, it's cached: `Map<issueId, repoId[]>`. Subsequent webhooks for the same issue skip routing entirely.

---

## 4. Prompt Assembly

**File:** `.cyrus-ref/packages/edge-worker/src/PromptBuilder.ts` (1560 lines)

### 4.1 Prompt Components (assembly order)

For a new session (`buildIssueContextPrompt`):

1. **Repository context** — `<context>` block with repo name, working directory, base branch (single-repo) or `<repositories>` block (multi-repo)
2. **Issue metadata** — `<linear_issue>` block with id, identifier, title, description, state, priority, URL
3. **Assignee info** — Nested in `<linear_issue>`: Linear display name, profile URL, GitHub username, GitHub user ID, GitHub noreply email
4. **Comment threads** — `<linear_comments>` block with threaded comments (root + replies, author + timestamp)
5. **New comment** (if continuation) — `<new_comment_to_address>` block
6. **Repository instructions** — Per-repo `appendInstruction` field
7. **Agent guidance** — `<agent_guidance>` block with workspace and team rules
8. **Attachment manifest** — List of uploaded attachments

### 4.2 XML Format

```xml
<context>
  <repository>{repo_name}</repository>
  <working_directory>{worktree_path}</working_directory>
  <base_branch>{base_branch}</base_branch>
</context>

<linear_issue>
  <id>{uuid}</id>
  <identifier>{TEAM-123}</identifier>
  <title>{issue title}</title>
  <description>{issue description}</description>
  <state>{started|backlog|done|...}</state>
  <priority>{0-4}</priority>
  <url>{linear URL}</url>
  <assignee>
    <linear_display_name>{name}</linear_display_name>
    <linear_profile_url>{url}</linear_profile_url>
    <github_username>{username}</github_username>
    <github_user_id>{numeric ID}</github_user_id>
    <github_noreply_email>{id}+{username}@users.noreply.github.com</github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
<comment_thread>
  <root_comment>
    <author>@{author_name}</author>
    <timestamp>{locale date string}</timestamp>
    <content>{comment body}</content>
  </root_comment>
  <replies>
    <reply>
      <author>@{reply_author}</author>
      <timestamp>{locale date string}</timestamp>
      <content>{reply body}</content>
    </reply>
  </replies>
</comment_thread>
</linear_comments>

<agent_guidance>
## Guidance from Team ({team_name})
{team guidance body}

## Guidance from Organization
{org guidance body}
</agent_guidance>
```

### 4.3 System Prompt Selection

**Method:** `determineSystemPromptFromLabels(labels, repository)`

Checks issue labels (case-insensitive) against prompt modes:

| Label                             | System Prompt                          | File                       |
| --------------------------------- | -------------------------------------- | -------------------------- |
| `orchestrator`                    | Orchestrator decompose/delegate/verify | `orchestrator.md`          |
| `graphite-orchestrator`           | Graphite-aware orchestrator            | `graphite-orchestrator.md` |
| `builder` (or configured labels)  | Feature implementation                 | `builder.md`               |
| `debugger` (or configured labels) | Bug fixing                             | `debugger.md`              |
| `scoper` (or configured labels)   | PRD/requirements                       | `scoper.md`                |

**Hardcoded rule:** `orchestrator` label ALWAYS triggers orchestrator mode regardless of `labelPrompts` config.

### 4.4 Guidance Rules

Fetched from Linear webhook payload or API. Formatted with origin precedence: Team > Organization.

### 4.5 GitHub Username Resolution

Resolves GitHub username from `gitHubUserId` via public API: `GET https://api.github.com/user/{id}` → `{ login }`. Used for commit attribution in noreply email format.

---

## 5. System Prompt Templates

**Directory:** `.cyrus-ref/packages/edge-worker/prompts/`

### 5.1 builder.md (version: builder-v1.3.2)

Specializes in feature implementation. Key instructions:

- Follow existing code patterns
- Ensure code quality and testing
- Consider edge cases and backward compatibility
- Deliver production-ready code

### 5.2 debugger.md (version: debugger-v1.3.0)

Specializes in debugging and fixing issues. Key instructions:

- Reproduce issues with failing tests
- Thorough root cause analysis
- Minimal, targeted fixes

### 5.3 orchestrator.md (version: orchestrator-v2.5.0)

Decomposes complex issues into sub-tasks and delegates. Key instructions:

- Create atomic, well-scoped sub-issues with `mcp__linear__create_issue`
- Delegate via `mcp__cyrus-tools__linear_agent_session_create`
- Halt and wait for child completion
- Mandatory verification process (navigate to child worktree, run tests)
- Never merge without verification
- Use `mcp__cyrus-tools__linear_agent_give_feedback` to iterate

### 5.4 scoper.md

PRD and requirement specification agent.

### 5.5 label-prompt-template.md

Multi-field template with variables: `{{git_context}}`, `{{issue_*}}`, `{{assignee_*}}`, `{{workspace_teams}}`, `{{workspace_labels}}`, `{{routing_context}}`

### 5.6 standard-issue-assigned-user-prompt.md

Default prompt template for issue assignment with multi-repo sections and conditional blocks.

### 5.7 todolist-system-prompt-extension.md

Appended to ALL system prompts. Guides TodoWrite/TodoRead usage.

---

## 6. Runner Selection & Adapters

**File:** `.cyrus-ref/packages/edge-worker/src/RunnerSelectionService.ts`

### 6.1 Runner Type Selection (priority order)

1. Description tag: `[agent=claude|codex|gemini|cursor]`
2. Issue labels: `cursor`, `codex`/`openai`, `gemini`, `claude`
3. Config `defaultRunner` setting
4. Auto-detect from available API keys
5. Fallback: `"claude"`

### 6.2 Model Selection (priority order)

1. Description tag: `[model=opus]`, `[model=gpt-5-codex]`, etc.
2. Issue labels: `opus`, `sonnet`, `haiku`, `gemini-2.5-pro`, `gpt-5-codex`, etc.
3. Config defaults: `claudeDefaultModel`, `codexDefaultModel`, `geminiDefaultModel`
4. Hardcoded fallback per runner

### 6.3 Available Runners

| Runner | SDK                              | Default Model  | Fallback Model   |
| ------ | -------------------------------- | -------------- | ---------------- |
| Claude | `@anthropic-ai/claude-agent-sdk` | opus           | sonnet           |
| Codex  | OpenAI Codex CLI                 | gpt-5.3-codex  | gpt-5.2-codex    |
| Gemini | `@google/gemini-cli`             | gemini-2.5-pro | gemini-2.5-flash |
| Cursor | Cursor CLI                       | gpt-5          | gpt-5            |

---

## 7. MCP Tool Configuration

**File:** `.cyrus-ref/packages/edge-worker/src/McpConfigService.ts`

### 7.1 Always-Included MCP Servers

| Server        | Type | URL                                       | Purpose                                                   |
| ------------- | ---- | ----------------------------------------- | --------------------------------------------------------- |
| `linear`      | HTTP | `https://mcp.linear.app/mcp`              | Official Linear API (read/write issues, comments, etc.)   |
| `cyrus-tools` | HTTP | `http://127.0.0.1:{port}/mcp/cyrus-tools` | Custom orchestration tools (delegation, feedback, upload) |
| `cyrus-docs`  | HTTP | `https://atcyrus.com/docs/mcp`            | Documentation search                                      |

### 7.2 Conditionally-Included Servers

| Server  | Condition                     | Type                                  | Purpose           |
| ------- | ----------------------------- | ------------------------------------- | ----------------- |
| `slack` | `SLACK_BOT_TOKEN` env var set | stdio (`npx slack-mcp-server@latest`) | Slack interaction |

### 7.3 Per-Repository MCP Servers

Each repo can define custom MCP config via `mcpConfigPath` (string or string[]). Loaded from project-level config files (e.g., `.claude/mcp.json`). Merged with global servers.

### 7.4 Context Scoping

Each MCP server context is scoped via `x-cyrus-mcp-context-id` header:

- Format: `{repoId}:{parentSessionId}` (or `{repoId}:anon:{timestamp}:{random}`)
- Purpose: Isolates MCP callbacks per orchestrator session
- Lifecycle: Created at session start, pruned when >500 entries

---

## 8. Custom MCP Tools (cyrus-tools)

**File:** `.cyrus-ref/packages/mcp-tools/src/tools/cyrus-tools/index.ts`

### 8.1 Tool Inventory

| Tool                                     | Description                            | Input                                                            | Implementation                                                                     |
| ---------------------------------------- | -------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `linear_agent_session_create`            | Create agent session on an issue       | `{ issueId, externalLink? }`                                     | GraphQL `agentSessionCreateOnIssue` mutation. Fires `onSessionCreated` callback.   |
| `linear_agent_session_create_on_comment` | Create agent session on a root comment | `{ commentId, externalLink? }`                                   | GraphQL `agentSessionCreateOnComment` mutation. Fires `onSessionCreated` callback. |
| `linear_agent_give_feedback`             | Send feedback to child session         | `{ agentSessionId, message }`                                    | Fires `onFeedbackDelivery` callback (async/fire-and-forget).                       |
| `linear_upload_file`                     | Upload file to Linear                  | `{ filePath, filename?, contentType?, makePublic? }`             | Reads file → `fileUpload()` → PUT to S3 signed URL. Returns asset URL.             |
| `linear_set_issue_relation`              | Create issue relationship              | `{ issueId, relatedIssueId, type }`                              | `createIssueRelation()` with type: blocks/related/duplicate.                       |
| `linear_get_child_issues`                | Fetch sub-issues of parent             | `{ issueId, limit?, includeCompleted?, includeArchived? }`       | `issue.children()` with filters. Returns structured array.                         |
| `linear_get_agent_sessions`              | List all agent sessions                | `{ first?, after?, before?, last?, includeArchived?, orderBy? }` | `agentSessions()` with pagination.                                                 |
| `linear_get_agent_session`               | Get single session details             | `{ sessionId }`                                                  | `agentSession()` with resolved relations (issue, creator, etc).                    |

### 8.2 Callback Interface

```typescript
interface CyrusToolsOptions {
  parentSessionId?: string;
  onSessionCreated?: (childSessionId: string, parentSessionId: string) => void;
  onFeedbackDelivery?: (childSessionId: string, message: string) => Promise<boolean>;
}
```

### 8.3 Feedback Delivery Flow

1. MCP tool called with `{ agentSessionId, message }`
2. `onFeedbackDelivery` callback fires
3. EdgeWorker looks up child session and runner
4. Posts "thought" activity to child's Linear session: "Received feedback from orchestrator"
5. Formats feedback as markdown prompt and injects via `handlePromptWithStreamingCheck()`
6. Child agent resumes with feedback message

---

## 9. Activity Sink & Posting

### 9.1 Activity Types (Linear Agent Activities)

| Type          | Purpose                                  | Ephemeral                          |
| ------------- | ---------------------------------------- | ---------------------------------- |
| `thought`     | Internal reasoning, status updates       | Usually yes                        |
| `action`      | Tool execution (name, parameter, result) | Yes for intermediate, no for final |
| `response`    | Final answer/summary                     | No                                 |
| `error`       | Failures                                 | No                                 |
| `elicitation` | Questions to user (with signal)          | No                                 |

### 9.2 Activity Signals

| Signal     | Purpose                       |
| ---------- | ----------------------------- |
| `auth`     | Authentication required       |
| `select`   | User must select from options |
| `stop`     | Agent is stopping             |
| `continue` | Agent is continuing           |

### 9.3 Event → Activity Mapping (AgentSessionManager)

| Agent Event                           | Activity Type | Ephemeral | Content             |
| ------------------------------------- | ------------- | --------- | ------------------- |
| Assistant text (no tool)              | thought       | no        | Raw text            |
| Assistant tool_use (Bash, Read, etc.) | action        | yes       | Formatted parameter |
| Assistant tool_use (TodoWrite)        | thought       | no        | Formatted checklist |
| Assistant tool_use (TaskCreate/List)  | thought       | no        | Formatted task      |
| Assistant tool_use (Task container)   | action        | no        | Task start marker   |
| User tool_result (success)            | action        | no        | Formatted result    |
| User tool_result (Task complete)      | thought       | no        | "✅ Task Completed" |
| SDK error (rate_limit, billing)       | error         | no        | Error message       |
| Result (success)                      | response      | no        | Final output        |
| Result (error)                        | error         | no        | Error message       |

### 9.4 Tool Formatting (ClaudeMessageFormatter)

| Tool       | Parameter Format                          | Result Format                 |
| ---------- | ----------------------------------------- | ----------------------------- |
| Bash       | Command text                              | Shell code block with output  |
| Read       | File path (lines X-Y)                     | Language-detected code block  |
| Edit       | File path                                 | Unified diff format           |
| Write      | File path                                 | "_File written successfully_" |
| Grep       | Pattern + path + glob                     | Match count + code block      |
| Glob       | Pattern + path                            | File count + list             |
| TaskCreate | "⏳ **{subject}**"                        | As-is                         |
| TaskUpdate | "{emoji} Task #{id} — {subject}"          | As-is                         |
| MCP tools  | First meaningful field (query, id, title) | Code block if multiline       |

### 9.5 High-Level Activity Posting (ActivityPoster)

| Method                                | Activity                        | Purpose                              |
| ------------------------------------- | ------------------------------- | ------------------------------------ |
| `postInstantAcknowledgment()`         | "I've received your request..." | Immediate feedback on assignment     |
| `postRoutingActivity()`               | Routing method + repos          | Show which repo was selected and why |
| `postSystemPromptSelectionThought()`  | "Entering 'debugger' mode..."   | Show prompt mode selection           |
| `postInstantPromptedAcknowledgment()` | "Getting started on that..."    | Feedback on continuation prompt      |
| `postParentResumeAcknowledgment()`    | "Resuming from child..."        | Orchestrator resumed                 |

---

## 10. Session Management

### 10.1 GlobalSessionRegistry

**File:** `.cyrus-ref/packages/edge-worker/src/GlobalSessionRegistry.ts`

| Data         | Structure                                  | Purpose                          |
| ------------ | ------------------------------------------ | -------------------------------- |
| Sessions     | `Map<sessionId, CyrusAgentSession>`        | All active sessions across repos |
| Entries      | `Map<sessionId, CyrusAgentSessionEntry[]>` | Conversation history per session |
| Parent-child | `Map<childSessionId, parentSessionId>`     | Orchestrator hierarchy           |

**Key methods:**

- `setParentSession(childId, parentId)` — register parent-child
- `getParentSessionId(childId)` — look up parent
- `getChildSessionIds(parentId)` — list all children
- `serializeState()` / `restoreState()` — persistence (version 3.0 format)
- `cleanup(maxAgeMs)` — prune old sessions

**Events emitted:** `sessionCreated`, `sessionUpdated`, `sessionCompleted`

### 10.2 Session Lifecycle

```
created → active (runner started) → complete/error (runner finished)
                                    ↘ stopped (user requested stop)
```

### 10.3 Child Completion → Parent Resume

When a child session completes:

1. AgentSessionManager detects `result` message from runner
2. Checks `getParentSessionId(childSessionId)` for parent mapping
3. Extracts child result text
4. Calls `resumeParentSession(parentSessionId, resultPrompt, childSessionId)`
5. Parent orchestrator gets a new turn with child's result

---

## 11. Orchestrator Mode

### 11.1 Activation

Issue has `orchestrator` label (case-insensitive, hardcoded check).

### 11.2 Capabilities (via system prompt + MCP tools)

1. **Decompose** — Create atomic sub-issues via `mcp__linear__create_issue` (with parentId)
2. **Delegate** — Start child agents via `mcp__cyrus-tools__linear_agent_session_create`
3. **Wait** — Orchestrator's turn completes; gets resumed when child finishes
4. **Verify** — Navigate to child worktree, run verification commands
5. **Iterate** — Send feedback via `mcp__cyrus-tools__linear_agent_give_feedback`
6. **Route** — Use `[repo=name]` tags in sub-issue descriptions for cross-repo routing

### 11.3 Routing Context Injection

When orchestrator mode is active and multiple repos are configured, prompt includes:

```xml
<repository_routing_context>
  <description>Priority order: Description Tag > Labels > Project > Team</description>
  <available_repositories>
    <repository name="frontend">
      <routing_methods>
        - Description tag: `[repo=org/frontend]`
        - Routing labels: "frontend"
        - Team keys: "FE"
      </routing_methods>
    </repository>
  </available_repositories>
</repository_routing_context>
```

### 11.4 Critical Rules (from orchestrator.md)

- MANDATORY VERIFICATION — cannot skip
- NO BLIND TRUST — never merge based solely on child's claim
- INITIAL BRANCH PUSH — must push branch before first sub-issue
- DO NOT ASSIGN YOURSELF AS DELEGATE

---

## 12. Worktree Management

**File:** `.cyrus-ref/packages/edge-worker/src/GitService.ts`

### 12.1 Branch Naming

- Primary: Linear's `issue.branchName` (if available from API)
- Fallback: `{ISSUE_ID}-{title-lowercase-dashed-truncated-30-chars}`
- Sanitization: backticks removed to prevent command injection

### 12.2 Setup Scripts

**Execution order:**

1. Global setup script (if `config.global_setup_script` set) — runs in workspace root
2. Repository setup script — `cyrus-setup.sh` (Unix) or `cyrus-setup.ps1` (Windows)

**Environment variables passed:**

```bash
LINEAR_ISSUE_ID="{issue UUID}"
LINEAR_ISSUE_IDENTIFIER="{TEAM-123}"
LINEAR_ISSUE_TITLE="{issue title}"
```

**Timeout:** 5 minutes per script. Failures logged but don't block session.

### 12.3 Base Branch Resolution (priority order)

1. `[repo=name#branch]` description tag override (highest)
2. Graphite blocked-by relationship (if `graphite` label present)
3. Parent issue's branch (if parent exists)
4. Repository config `baseBranch` (default: `"main"`)

### 12.4 Worktree Layout

- **Single repo:** `{workspaceBaseDir}/{ISSUE-ID}/`
- **Multi-repo:** `{workspaceBaseDir}/{ISSUE-ID}/{repo-name}/` (sub-directories per repo)
- **No repos (chat):** Plain folder at `{workspaceBaseDir}/{ISSUE-ID}/`

---

## 13. Issue Lifecycle Handlers

### 13.1 Issue State Change (Done/Canceled)

**Trigger:** `Issue` webhook with `action: "update"` where `updatedFrom.stateId` differs

**Cleanup sequence:**

1. Stop all active runners for the issue
2. Post response activity: "Session stopped — {ISSUE-ID} was marked as Done"
3. Remove sessions from registry
4. Delete git worktrees for the issue

### 13.2 Issue Content Update (description/title change)

**Trigger:** `Issue` webhook with `action: "update"` where `updatedFrom` contains `title`, `description`, or `attachments`

**Behavior:**

1. Deduplicate by `{createdAt}:{issueId}` key (prunes >500)
2. Find active session via repository cache or session lookup
3. Build update prompt showing old → new values
4. Download new attachments if description changed
5. Inject update into active session

### 13.3 Stop Signal Processing

**Detection paths:**

- Linear: `agentActivity.signal === "stop"` OR text matches stop pattern
- All platforms: Keyword detection ("stop", "stop working", etc.)

**Processing:**

1. Mark session for stop (`stopRequestedSessions.add(sessionId)`)
2. Call `runner.stop()` to signal termination
3. Post confirmation activity: "I've stopped working as requested"
4. Session status set to "stopped" (not "complete")

---

## 14. User Access Control

**File:** `.cyrus-ref/packages/edge-worker/src/UserAccessControl.ts`

### 14.1 Access Check Logic

```
1. Build blocklist = global.blockedUsers ∪ repo.blockedUsers
2. If user in blocklist → BLOCKED
3. Determine allowlist:
   - repo.allowedUsers overrides global (if defined)
   - global.allowedUsers used otherwise
   - No allowlist = everyone allowed
4. If allowlist exists AND user NOT in it → BLOCKED
5. Otherwise → ALLOWED
```

### 14.2 User Matching

Supports: string (user ID), `{ id: string }`, `{ email: string }` (case-insensitive)

### 14.3 Block Behavior

- `"silent"` — Silently ignore (default)
- `"comment"` — Post comment with block message
- Template variables: `{{userName}}`, `{{userId}}`

---

## 15. Configuration Schema

### 15.1 Repository Config

```typescript
{
  id: string;
  name: string;
  repositoryPath: string;
  baseBranch?: string;                // Default "main"
  linearWorkspaceId: string;
  githubUrl?: string;
  gitlabUrl?: string;
  routingLabels?: string[];           // Labels that route here
  teamKeys?: string[];                // Team keys that route here
  projectKeys?: string[];             // Project names that route here
  labelPrompts?: {                    // Label → system prompt mapping
    debugger?: string[] | { labels: string[] };
    builder?: string[] | { labels: string[] };
    orchestrator?: string[] | { labels: string[] };
  };
  mcpConfigPath?: string | string[];  // Project MCP server config
  appendInstruction?: string;         // Extra instructions for all sessions
  userAccessControl?: { allowedUsers?, blockedUsers?, blockBehavior?, blockMessage? };
}
```

### 15.2 Global Config

```typescript
{
  defaultRunner?: "claude" | "codex" | "gemini" | "cursor";
  claudeDefaultModel?: string;
  codexDefaultModel?: string;
  geminiDefaultModel?: string;
  global_setup_script?: string;       // Path to global setup script
  userAccessControl?: { ... };        // Global access control
}
```

---

## 16. Slack Integration

**Goal:** Non-technical teams @mention the agent in Slack → agent runs → replies in thread. Can also create Linear issues for code work.

### 16.1 Architecture

| Component           | File                                               | Purpose                                                             |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| SlackEventTransport | `slack-event-transport/src/SlackEventTransport.ts` | Webhook ingress for `app_mention` events                            |
| SlackMessageService | `slack-event-transport/src/SlackMessageService.ts` | Slack Web API: post messages, fetch threads, add reactions          |
| SlackChatAdapter    | `edge-worker/src/SlackChatAdapter.ts`              | Builds Slack-specific system prompts and extracts task instructions |
| ChatSessionHandler  | `edge-worker/src/ChatSessionHandler.ts`            | Generic session engine for transient (no-issue) chat sessions       |

### 16.2 End-to-End Flow

```
1. User @mentions bot in Slack channel or thread
2. SlackEventTransport receives app_mention webhook
3. Verify signature (HMAC-SHA256 direct or Bearer token proxy)
4. Add 👀 reaction to acknowledge
5. Fetch thread context (prior messages in thread for continuity)
6. SlackChatAdapter extracts task from mention text (strips bot @)
7. ChatSessionHandler creates transient session:
   - NO Linear issue
   - NO git repository/worktree
   - Plain temp directory as workspace
8. Build Slack-specific system prompt:
   - Available repository list (for creating Linear issues)
   - Routing context (description tag syntax)
   - Slack mrkdwn formatting rules (no tables, no # headers, *bold* not **bold**)
   - Instructions to create Linear issues for code work (not direct edits)
9. Start runner with prompt
10. Stream responses back to Slack thread
11. Follow-up @mentions in same thread → injected via addStreamMessage() or --continue
```

### 16.3 Slack System Prompt Rules

- Use Slack mrkdwn, not Markdown (no tables, no `#` headers, no image embeds)
- Use `*bold*` not `**bold**`, `_italic_` not `*italic*`
- For code work: create Linear issues with `[repo=name]` tags, assign to self
- For questions: answer directly in thread
- Available MCP tools: Linear, cyrus-tools, cyrus-docs, Slack MCP

### 16.4 Thread Continuity

Sessions tracked per thread key (`channel:thread_ts`). Follow-ups either:

- Injected via `runner.addStreamMessage()` (real-time, if runner supports streaming input)
- Resumed via `--continue` flag (after completion)

### 16.5 Webhook Verification

Two modes (runtime switchable):

- **Direct** (self-hosted): HMAC-SHA256 signature + timestamp validation (5-min window)
- **Proxy** (cloud): Bearer token authentication

### 16.6 MCP Tools for Slack Sessions

Same as Linear sessions: `linear`, `cyrus-tools`, `cyrus-docs`, `slack` (if configured). BUT tool permissions default to read-only mode (no Write/Edit) for chat sessions.

---

## 17. Interactive User Questions (AskUserQuestion)

**File:** `.cyrus-ref/packages/edge-worker/src/AskUserQuestionHandler.ts`

Agents can pause execution and ask users to choose between options. This bridges the Claude SDK's `AskUserQuestion` tool with Linear's `select` signal.

### 17.1 Flow

```
1. Agent calls AskUserQuestion tool with { question, options[] }
2. AskUserQuestionHandler posts Linear activity with signal: "select"
   and signalMetadata: { options: [...] }
3. Agent execution pauses (promise awaiting resolution)
4. User picks an option in Linear UI
5. Linear sends AgentSessionPrompted webhook with user's selection
6. Handler resolves the pending promise with user's choice
7. Agent resumes with the selected option
```

### 17.2 Pending Question Storage

```typescript
pendingQuestions: Map<sessionId, { resolve; reject; question; options }>;
```

Pending questions are matched to incoming `prompted` webhooks by session ID.

---

## 18. Streaming / Mid-Implementation Prompts

**File:** `.cyrus-ref/packages/core/src/StreamingPrompt.ts`

Cyrus can inject prompts into a running agent session without waiting for the current turn to complete.

### 18.1 How It Works

- `StreamingPrompt`: Queue-based async iterator
- Runners that support `addStreamMessage()` accept new input mid-execution
- Used for: Slack follow-up messages, issue description updates, user feedback
- `handlePromptWithStreamingCheck()` detects if runner supports streaming and routes accordingly

### 18.2 When It's Used

- Slack thread follow-ups (user sends another message while agent is working)
- Issue content updates (description changed mid-session)
- Orchestrator feedback delivery to child sessions

---

## 19. Attachment Handling

**File:** `.cyrus-ref/packages/edge-worker/src/AttachmentService.ts`

### 19.1 Capabilities

- Downloads attachments from Linear issues (extracts URLs from description/comments)
- Supports Linear's `https://uploads.linear.app/*` file hosting
- 20-file limit with size/type validation
- Stores in `~/.cyrus/{workspaceFolderName}/attachments/`
- Generates attachment manifest for prompt inclusion

### 19.2 Manifest Format

The manifest is a text summary of available attachments included in the prompt, so the agent knows what files are available without downloading them again.

---

## 20. WorktreeIncludeService

**File:** `.cyrus-ref/packages/edge-worker/src/WorktreeIncludeService.ts`

### 20.1 Purpose

Copies files that are in `.gitignore` but explicitly listed in `.worktreeinclude` into new worktrees. This ensures sensitive/generated files (env configs, build artifacts, etc.) are available in worktrees even though they're gitignored.

### 20.2 Behavior

1. Parse `.worktreeinclude` file (if present in repo root)
2. Find files matching `.worktreeinclude` patterns that are ALSO in `.gitignore`
3. Copy matched files into the new worktree
4. Runs BEFORE setup scripts

---

## 21. Tool Permission System

**File:** `.cyrus-ref/packages/edge-worker/src/ToolPermissionResolver.ts`

### 21.1 Tool Presets

| Preset        | Tools Included                                                                          |
| ------------- | --------------------------------------------------------------------------------------- |
| `readOnly`    | Read, Grep, Glob, LS, WebFetch, WebSearch, NotebookRead, ToolSearch, TodoRead (9 tools) |
| `safe`        | All readOnly + Write, Edit, NotebookEdit (no Bash) (11 tools)                           |
| `all`         | All safe + Bash (12 tools)                                                              |
| `coordinator` | Orchestrator-specific tools (Linear MCP, cyrus-tools MCP)                               |

### 21.2 Resolution Priority

1. Repository-specific `allowedTools` / `disallowedTools`
2. Label-based tool restrictions (from `labelPrompts` config)
3. Global `defaultAllowedTools`
4. Safe tools fallback

### 21.3 Per-Runner Translation

Tool names are translated per runner:

- Claude: Native tool names
- Cursor: Permission tokens (`Read(./**)`, `Write(./**)`, etc.)
- Codex: Codex-specific tool names
- Gemini: Gemini-specific tool names

---

## 22. Graphite Stacking Workflows

### 22.1 Activation

Issue has BOTH `graphite` AND `orchestrator` labels → loads `graphite-orchestrator.md` prompt.

### 22.2 How Stacking Works

```
Parent issue ORCH-1 decomposes into:
  SUB-1 (blocks SUB-2) → branch: feat/sub-1 (based on main)
  SUB-2 (blocks SUB-3) → branch: feat/sub-2 (based on feat/sub-1)
  SUB-3               → branch: feat/sub-3 (based on feat/sub-2)
```

- Orchestrator uses `mcp__cyrus-tools__linear_set_issue_relation` with `type: "blocks"` to define stack
- Base branch resolution detects blocking issues and uses their branch as parent
- PRs created via `gt submit` (Graphite CLI) instead of `gh pr create`
- Graphite handles automatic rebase management

### 22.3 Base Branch from Blocking Issue

When an issue has the `graphite` label AND is blocked by another issue, the blocking issue's branch becomes the base branch for the new worktree. This creates the stacking chain automatically.

---

## 23. Session Persistence & Recovery

**File:** `.cyrus-ref/packages/core/src/PersistenceManager.ts`

### 23.1 What's Persisted

- GlobalSessionRegistry state: all sessions, entries, parent-child maps
- Repository cache: issue → repo mappings
- Pending selections: unresolved user choices

### 23.2 Format

```typescript
{
  version: "3.0",
  sessions: Record<sessionId, SerializedCyrusAgentSession>,
  entries: Record<sessionId, CyrusAgentSessionEntry[]>,
  childToParentMap: Record<childId, parentId>
}
```

### 23.3 Recovery

On startup, `restoreState()` loads persisted state. Supports migration from older versions. Active runners are NOT recovered (only metadata) — sessions resume when next webhook arrives.

---

## 24. GitHub Token Resolution

**File:** `.cyrus-ref/packages/github-event-transport/src/GitHubAppTokenProvider.ts`

### 24.1 Three-Tier Fallback

1. **Proxy-forwarded installation token** — Cloud users: token forwarded from CYHOST proxy
2. **Self-minted GitHub App token** — Self-hosted: JWT signed with App private key → installation token
3. **`GITHUB_TOKEN` PAT** — Legacy fallback: personal access token from env var

### 24.2 App Token Caching

Tokens cached with 5-minute pre-expiry refresh. JWT signing uses App private key from config.

---

## 25. Parity Checklist

Use this to track what T3 Code has implemented vs what's missing.
Items marked `[N/A]` are not needed because T3 Code has its own equivalent.

### Webhook Ingress (Linear)

- [x] `AgentSessionEvent.created` — create thread + worktree + start agent
- [x] `AgentSessionEvent.prompted` — continue session / stop signal / repo selection
- [x] `AppUserNotification.issueUnassignedFromYou` — stop + cleanup
- [x] `Issue.update` (state change) — Done/Canceled → stop + delete worktrees
- [x] `Issue.update` (content change) — inject updated description into active session
- [ ] `Issue.delete` — cleanup
- [ ] `IssueComment.create` (root comment) — build continuation prompt → resume session

### Webhook Ingress (GitHub)

- [ ] `issue_comment` on PR — respond to PR comments
- [ ] `pull_request_review_comment` — respond to inline review comments
- [ ] `pull_request_review` (changes_requested) — respond to review
- [ ] GitHub App token minting (JWT → installation token, 3-tier fallback)

### Webhook Ingress (Slack)

- [ ] `app_mention` — chat-style agent session in thread
- [ ] Slack webhook verification (HMAC-SHA256 direct / Bearer proxy)
- [ ] Thread context fetching (prior messages for continuity)
- [ ] 👀 reaction acknowledgment
- [ ] Response posting in thread
- [ ] Thread continuity (follow-up @mentions → addStreamMessage or --continue)

### Repository Routing

- [x] Label + team match (basic)
- [x] Description tag routing (`[repo=name]`, `[repo=name#branch]`)
- [x] Project-based routing (`repo.projectKeys`)
- [ ] Team prefix routing (issue identifier prefix)
- [x] Active session cache (skip re-routing on subsequent webhooks)
- [ ] User elicitation when no match (Linear select signal)
- [ ] Multi-repo routing (single issue → multiple repos)
- [x] Repository caching per issue

### Prompt Assembly

- [x] Issue metadata in XML (`<linear_issue>` block with id, identifier, title, description, state, priority, URL)
- [x] Comment history (threaded XML: root comments + replies, author + timestamp)
- [x] Repository context (`<context>` block with repo name, working directory, base branch)
- [ ] Multi-repo context (`<repositories>` block with per-repo sections)
- [ ] Assignee info (Linear name, profile URL, GitHub username, user ID, noreply email)
- [ ] GitHub username resolution (public API `GET /user/{id}`)
- [x] Agent guidance rules from Linear (workspace + team level, `<agent_guidance>` block)
- [ ] Per-repo custom instructions (`appendInstruction` field)
- [x] Label-based system prompt selection (builder/debugger/orchestrator/scoper)
- [ ] Workspace teams + labels context
- [x] Routing context for orchestrator (available repos + routing methods)
- [x] Continuation prompt (follow-up turns with just new comment)
- [x] Issue update prompt (old → new values for title/description/attachments)
- [ ] Attachment manifest inclusion

### System Prompts

- [x] `builder.md` — feature implementation
- [x] `debugger.md` — bug fixing
- [x] `orchestrator.md` — decompose/delegate/verify
- [x] `graphite-orchestrator.md` — Graphite stacked PRs orchestration
- [x] `scoper.md` — PRD/requirements
- [x] TodoWrite extension (appended to all prompts)
- [ ] Slack-specific formatting rules (mrkdwn, no tables)

### Runner / Provider Selection

- [N/A] Multiple runner adapters — T3 Code has its own CodexAdapter + ClaudeAdapter
- [ ] Description tag `[agent=codex|claude]` for provider selection
- [ ] Label-based provider selection
- [ ] Model override `[model=opus]` / `[model=gpt-5-codex]`
- [ ] Default provider/model from config

### MCP Configuration

- [x] Linear MCP server (official `mcp.linear.app`) injected into worktree
- [x] Custom MCP server (T3-tools, equivalent to cyrus-tools)
- [ ] Per-repo MCP config (from project `.claude/mcp.json` or similar)
- [ ] Slack MCP server (conditional, if SLACK_BOT_TOKEN set)
- [x] Context scoping via headers (x-t3-mcp-context-id)
- [x] MCP config written to worktree before Codex starts

### Custom MCP Tools (T3-tools)

- [x] `linear_agent_session_create` — delegate to child agent on issue
- [x] `linear_agent_session_create_on_comment` — delegate from root comment
- [x] `linear_agent_give_feedback` — send feedback to running child
- [x] `linear_upload_file` — upload files/screenshots to Linear
- [x] `linear_set_issue_relation` — create blocks/related/duplicate relationships
- [x] `linear_get_child_issues` — fetch sub-issues with filters
- [x] `linear_get_agent_sessions` — list sessions (paginated)
- [x] `linear_get_agent_session` — get single session details

### Activity Sink (Linear)

- [x] Turn start → ephemeral thought "Starting work..."
- [x] Tool calls → ephemeral action (formatted parameter + result)
- [ ] Task checklists → non-ephemeral thought (emoji formatting: ⏳🔄✅)
- [x] Assistant text → thought
- [x] Intermediate thoughts → ephemeral thought
- [x] Turn diff completed → action with file list + additions/deletions
- [x] Session error → error activity
- [x] Session completed → response activity
- [ ] Instant acknowledgment ("I've received your request...")
- [ ] Routing method activity (show which repo was selected and why)
- [ ] System prompt selection activity ("Entering 'debugger' mode...")
- [ ] Tool result formatting (language-detected code blocks, unified diffs)

### Session Management

- [x] Parent-child session tracking (thread_relationships table)
- [x] Two-phase child registration (MCP tool → webhook fills in threadId)
- [x] Child turn completion → parent resume with result
- [x] Feedback delivery (parent → child via new turn)
- [~] Session persistence and recovery across server restarts (orchestration state recovers; MCP contexts are session-only)
- [x] Stop signal processing (Linear signal, text pattern, state change)
- [ ] Session cleanup by age

### Interactive Features

- [ ] AskUserQuestion tool → Linear select signal → user picks option → resume
- [ ] Streaming/mid-implementation prompts (inject into running session)
- [x] Issue content updates fed into active sessions

### Orchestrator Mode

- [x] `orchestrator` label detection (hardcoded, case-insensitive)
- [x] Orchestrator system prompt with decompose/delegate/verify workflow
- [x] Mandatory verification process (navigate to child worktree, run tests)
- [x] Routing context injection (available repos + routing methods)
- [x] Parent-child session tracking via custom MCP tools
- [x] Child completion → parent auto-resume

### Graphite Stacking (optional, defer)

- [x] `graphite-orchestrator.md` system prompt
- [x] `linear_set_issue_relation` with `type: "blocks"` for stack ordering
- [ ] Base branch resolution from blocking issue
- [ ] PR creation via `gt submit` instead of `gh pr create`

### Worktree Management

- [x] Worktree creation per issue
- [x] Setup script execution (global + per-repo)
- [ ] Setup script env vars (`LINEAR_ISSUE_ID`, `LINEAR_ISSUE_IDENTIFIER`, `LINEAR_ISSUE_TITLE`)
- [x] Base branch resolution (description tag > parent > default)
- [x] Worktree cleanup on issue state change (Done/Canceled)
- [ ] `.worktreeinclude` file support (copy gitignored files into worktree)
- [ ] Multi-repo worktree layout (sub-directories per repo)

### Attachment Handling

- [ ] Download attachments from Linear issue descriptions/comments
- [ ] Attachment manifest generation for prompt inclusion
- [ ] File size/type validation (20-file limit)
- [ ] Storage in server-side attachments directory

### Issue Lifecycle

- [x] Terminal state cleanup (Done/Canceled → stop sessions + delete worktrees)
- [x] Content update injection (description/title changes → active session)
- [ ] Issue deletion cleanup
- [ ] Issue update deduplication (`{createdAt}:{issueId}` key, prune >500)

### Access Control

- [ ] Per-workspace user allowlist/blocklist
- [ ] Per-repo user allowlist/blocklist (overrides workspace)
- [ ] Block behavior (silent / comment with template)
- [ ] User matching by ID or email (case-insensitive)

### Configuration

- [x] Per-repo routing config (labels, teams, projects, description tags)
- [x] Per-repo label → prompt mapping (`labelPrompts`)
- [ ] Per-repo MCP config paths
- [ ] Per-repo custom instructions (`appendInstruction`)
- [ ] Per-repo tool permissions (allowed/disallowed tools)
- [ ] Global defaults (provider, model, setup script)
- [x] Hot-reload config on file change
- [ ] Issue update trigger toggle per repo

### T3 Code UI Integration (not from cyrus — new for T3 Code)

- [ ] Linear issue metadata visible in thread sidebar (issue identifier badge)
- [ ] Distinguish Linear-triggered threads from manual threads
- [ ] View all background agent worktrees and their status
- [ ] View Linear issue context within thread view
