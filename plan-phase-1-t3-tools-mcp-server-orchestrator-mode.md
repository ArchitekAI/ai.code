# Plan: Phase 1 — T3-Tools MCP Server + Orchestrator Mode

## Context

Phase 0 gave Linear-triggered agents a real brain: enriched prompts, official Linear MCP access, and activity streaming. What is still missing is the part that makes Cyrus feel like an actual orchestrator:

1. A custom MCP server with the same Linear session-management surface as `cyrus-tools`
2. Parent/child session wiring that can safely resume the parent exactly once per child turn
3. Parent verification that can actually inspect child worktrees
4. Cyrus-style repository routing, adapted to T3 Code's **projects** model
5. Prompt/runtime expectations that do not accidentally regress into Codex-only behavior

This plan ports that orchestration layer into T3 Code while adapting Cyrus's repo-selection model to how T3 Code represents local repositories as `projects`.

## Current T3 baseline

Another coding agent should assume the following is already true in this fork:

1. Phase 0 prompt assembly already exists in `apps/server/src/linear/Layers/LinearPromptAssembler.ts`
2. Linear-triggered worktrees already get official Linear MCP config from `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`
3. Current webhook routing still only supports:
   - `labelName` + optional `teamKey`
   - `teamKey`
   - `defaultWorkspaceRoot`
4. Current prompt selection only supports:
   - `builder`
   - `debugger`
   - hardcoded `orchestrator`
5. Claude currently only gets `additionalDirectories: [cwd]` and does not have Cyrus-style prompt-type tool policy
6. T3 Code already has an orchestration project model, but it does **not** yet have a Cyrus-style repository config object

## Locked implementation decisions

These decisions are intentionally already made so a follow-up coding agent does not need to rediscover them:

1. Slack remains out of scope
2. Use T3 projects/workspaces as the repository abstraction
3. Write MCP config to both `.mcp.json` and `.codex/mcp.json`
4. Do not invent a second routing config source: extend `linearProjectMappings` so it becomes the routing + prompt/profile source of truth for Linear-triggered sessions
5. Do not make this Codex-only: every MCP, prompt, and verification pathway must preserve Claude parity too

## Reference implementation files

The coding agent implementing this should read these files first.

### Cyrus reference

1. `.cyrus-ref/packages/edge-worker/src/PromptBuilder.ts`
2. `.cyrus-ref/packages/edge-worker/src/ToolPermissionResolver.ts`
3. `.cyrus-ref/packages/edge-worker/src/McpConfigService.ts`
4. `.cyrus-ref/packages/edge-worker/src/ActivityPoster.ts`
5. `.cyrus-ref/packages/edge-worker/src/GitService.ts`
6. `.cyrus-ref/packages/edge-worker/prompts/builder.md`
7. `.cyrus-ref/packages/edge-worker/prompts/debugger.md`
8. `.cyrus-ref/packages/edge-worker/prompts/scoper.md`
9. `.cyrus-ref/packages/edge-worker/prompts/orchestrator.md`
10. `.cyrus-ref/packages/edge-worker/prompts/graphite-orchestrator.md`
11. `.cyrus-ref/packages/edge-worker/prompts/standard-issue-assigned-user-prompt.md`
12. `.cyrus-ref/packages/edge-worker/prompts/todolist-system-prompt-extension.md`
13. `.cyrus-ref/packages/mcp-tools/src/tools/cyrus-tools/index.ts`

### T3 Code files to adapt

1. `apps/server/src/linear/Layers/LinearWebhookHandler.ts`
2. `apps/server/src/linear/Layers/LinearPromptAssembler.ts`
3. `apps/server/src/linear/Layers/LinearClient.ts`
4. `apps/server/src/linear/Services/LinearClient.ts`
5. `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`
6. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
7. `apps/server/src/provider/Layers/ClaudeAdapter.ts`
8. `apps/server/src/provider/Layers/CodexAdapter.ts`
9. `apps/server/src/codexAppServerManager.ts`
10. `packages/contracts/src/linear.ts`
11. `packages/contracts/src/settings.ts`
12. `packages/contracts/src/orchestration.ts`
13. `packages/contracts/src/provider.ts`

## Parity Goals

This phase should close the remaining Cyrus parity gaps for Linear orchestration:

1. Match the `cyrus-tools` Linear orchestration tool surface
2. Match Cyrus's parent-child resume model
3. Match Cyrus's multi-repo routing model, but route into T3 Code `projects`
4. Match Cyrus's non-Slack MCP surface (`linear`, `cyrus-tools`, `cyrus-docs`) with T3 equivalents
5. Match Cyrus's label-driven prompt/skill surface (`builder`, `debugger`, `scoper`, `orchestrator`, `graphite-orchestrator`)
6. Preserve provider parity for both Codex and Claude

This phase does **not** add Slack behavior.

## Cyrus parity surface, translated into T3 Code terms

Because T3 Code does not have Cyrus's exact repository config model, parity needs to be expressed in T3-native terms:

1. **Repositories** in Cyrus map to **T3 Code projects/workspaces**
2. **Skills** in Cyrus map to **label-selected prompt modes + prompt-specific runtime expectations**
3. **Workspace MCPs** in Cyrus map to **MCP config written into each Linear-triggered worktree**
4. **Repository routing metadata** in Cyrus maps to **`linearProjectMappings` + active T3 projects**

That means this plan must explicitly cover four parity surfaces:

1. Same non-Slack MCP set available to Linear sessions:
   - `linear`
   - `t3-tools` (Cyrus `cyrus-tools` equivalent)
   - `t3-docs` (Cyrus `cyrus-docs` equivalent)
2. Same label-driven prompt modes:
   - `builder`
   - `debugger`
   - `scoper`
   - `orchestrator`
   - `graphite-orchestrator`
3. Same prompt-building primitives:
   - standard issue-assigned prompt template
   - new-comment metadata handling
   - repository routing context
   - todo/task extension where applicable
4. Same routing affordances:
   - explicit repo tag
   - routing labels
   - Linear project keys
   - team keys

## Repo Selection Model (Cyrus parity, adapted to T3 projects)

### How repo selection works in Cyrus

In Cyrus, an orchestrator can route a sub-issue to another repository by:

1. Adding a description tag like `[repo=org/repo-name]`
2. Applying a routing label
3. Creating the issue in a specific Linear team
4. Adding the issue to a specific Linear project

The orchestrator sees those options through `<repository_routing_context>` in the prompt.

### How repo selection should work in T3 Code

T3 Code does not have Cyrus's repository config objects. It has **projects**, each of which points at one local `workspaceRoot`. So parity means:

1. Each routable local repository is represented by a T3 Code `project`
2. `linearProjectMappings` becomes the routing table from Linear issue metadata to a target T3 project/workspace
3. The orchestrator prompt advertises those routable T3 projects using Cyrus-style routing context

### Matching rules

When a Linear webhook creates or resumes a session, resolve the target project/workspace in this order:

1. Explicit repo tag in the issue description:
   - `[repo=web-app]`
   - `[repo=web-app#release/2026-q2]`
2. Routing label match
3. Linear project key match
4. Team key match
5. Fallback `defaultWorkspaceRoot`

### Mapping schema changes

Extend `LinearProjectMapping` so each mapping can describe a T3 Code project as a routable repository target **and** the prompt/tool profile for that workspace:

```typescript
export const LinearProjectMapping = Schema.Struct({
  organizationId: Schema.optional(TrimmedNonEmptyString),
  teamKey: Schema.optional(TrimmedNonEmptyString),
  labelName: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: TrimmedNonEmptyString,
  baseBranch: Schema.optional(TrimmedNonEmptyString),

  // Cyrus-style routing metadata, adapted to T3 projects
  routeKey: Schema.optional(TrimmedNonEmptyString), // defaults to basename(workspaceRoot)
  routeAliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  routingLabels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  projectKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),

  // Cyrus-style label prompt metadata, adapted to T3 settings
  promptLabels: Schema.optional(
    Schema.Struct({
      builder: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      debugger: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      scoper: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      orchestrator: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      graphite: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    }),
  ),

  // Prompt-specific tool policy, stored with the same routing record so prompt mode,
  // tool policy, and routing stay resolved from one source of truth.
  toolPolicy: Schema.optional(
    Schema.Struct({
      defaultAllowedToolsPreset: Schema.optional(TrimmedNonEmptyString),
      defaultDisallowedTools: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      promptDefaults: Schema.optional(Schema.Unknown),
    }),
  ),
});
```

### Why this source of truth is chosen

Use `linearProjectMappings` instead of expanding the orchestration project schema in Phase 1.

Reasons:

1. webhook routing already depends on `linearProjectMappings`
2. Cyrus repository config bundles routing + label prompts + tool policy together
3. this keeps prompt selection, routing, and tool policy aligned during the port
4. it avoids widening core orchestration project events just to support Linear parity

### Routing context generation

For orchestrator prompts, generate `<repository_routing_context>` from the configured `linearProjectMappings` and active T3 Code projects.

The context should include:

1. T3 project title
2. `workspaceRoot`
3. `routeKey`
4. Valid description-tag forms
5. Routing labels
6. Team keys
7. Project keys
8. Base branch
9. Which project is the current one

### Resolution pseudocode

```ts
function resolveProjectMapping(issue, mappings, defaultWorkspaceRoot) {
  const repoDirective = parseRepoDirective(issue.description);

  if (repoDirective) {
    return findByRouteKeyOrAlias(repoDirective.routeKey, mappings);
  }

  const byRoutingLabel = findByRoutingLabel(issue.labelNames, mappings);
  if (byRoutingLabel) return byRoutingLabel;

  const byProjectKey = findByProjectKey(issue.projectKeys, mappings);
  if (byProjectKey) return byProjectKey;

  const byTeamKey = findByTeamKey(issue.teamKey, mappings);
  if (byTeamKey) return byTeamKey;

  return defaultWorkspaceRoot ? { workspaceRoot: defaultWorkspaceRoot } : null;
}
```

If the repo directive contains `#branch`, that branch overrides the mapping's default `baseBranch` for the child worktree/bootstrap.

### Base-branch selection parity

Repo routing parity is not complete unless branch selection parity is also covered.

For Linear-created child sessions, resolve the base branch in this order:

1. explicit repo tag override: `[repo=repo-name#branch-name]`
2. Graphite blocked-by relationship branch, if the issue has the graphite label and a blocking issue session/thread is known
3. parent thread branch, when the child is staying in the same project/workspace and there is no stronger override
4. mapping `baseBranch`
5. fallback default branch (for now assume `main` if nothing better exists)

This mirrors Cyrus's stacked-flow behavior closely enough for T3 Code.

---

## How orchestration should work

```text
1. Issue ORCH-1 is assigned and has the orchestrator label
2. T3 Code resolves the target project/workspace using the routing rules above
3. T3 Code loads orchestrator.md and injects repository routing context
4. Orchestrator creates sub-issues and starts child agent sessions through t3-tools
5. T3 Code stores parent-child mapping immediately by child Linear session id
6. Child webhook arrives, resolves target project/workspace, creates child thread/worktree
7. Child finishes a turn
8. T3 Code resumes the parent exactly once for that child turn
9. Parent receives:
   - child summary
   - child issue identifier
   - child worktree path
10. Parent verifies work inside the child worktree
11. If verification fails, parent uses feedback tool to resume child
12. Repeat until all children are verified and merged
```

**Key parity rule:** the parent does not stay alive while children work. It is resumed by a new turn when a child turn completes, matching Cyrus.

---

## What to build

### 1a. Install MCP SDK

**`apps/server/package.json`**

Add:

```json
"@modelcontextprotocol/sdk": "^1.x"
```

### Workspace Docs MCP parity (`cyrus-docs` → `t3-docs`)

Cyrus always exposes a workspace docs MCP alongside `linear` and `cyrus-tools`.
If the goal is full parity, T3 Code needs the same non-Slack MCP trio:

1. `linear`
2. `t3-tools`
3. `t3-docs`

#### Purpose

`t3-docs` is the T3 Code analogue of `cyrus-docs`. It should let agents answer:

1. how T3 Code works internally
2. how the Linear orchestration flow behaves
3. what project-specific conventions or fork-only deltas exist

#### Minimum scope

Expose a searchable documentation MCP over local/server-owned docs sources:

1. `AGENTS.md`
2. `docs/t3code-delta-log.md`
3. selected docs under `docs/`
4. implementation docs or prompt docs added as part of this parity effort

#### Suggested tool surface

At minimum:

1. `search_documentation`
2. `get_document` or equivalent fetch-by-id/path helper

#### Files to create

1. `apps/server/src/mcp/t3Docs.ts`
2. `apps/server/src/mcp/Layers/McpDocsRoute.ts`

#### Files to modify

1. `apps/server/src/server.ts`
2. `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`

---

### 1b. T3-Tools MCP Server

**Create `apps/server/src/mcp/t3Tools.ts`**

This module should mirror Cyrus's `createCyrusToolsServer(...)`, but use T3 Code services/callbacks.

#### Tools to implement

**Tool 1: `linear_upload_file`**

- Input: `{ filePath, filename?, contentType?, makePublic? }`
- Match Cyrus behavior, including `makePublic`

**Tool 2: `linear_agent_session_create`**

- Input: `{ issueId, externalLink? }`
- Call Linear GraphQL `agentSessionCreateOnIssue`
- Callback: `onSessionCreated(childLinearSessionId, parentThreadId)`

**Tool 3: `linear_agent_session_create_on_comment`**

- Input: `{ commentId, externalLink? }`
- Call Linear GraphQL `agentSessionCreateOnComment`
- Same callback behavior as above

**Tool 4: `linear_agent_give_feedback`**

- Input: `{ agentSessionId, message }`
- Await `onFeedbackDelivery(...)`
- Swallow/log callback failures and still return `{ success: true }` to match Cyrus

**Tool 5: `linear_set_issue_relation`**

- Input: `{ issueId, relatedIssueId, type }`
- Match Cyrus semantics for `blocks`, `related`, and `duplicate`

**Tool 6: `linear_get_child_issues`**

- Input: `{ issueId, limit?, includeCompleted?, includeArchived? }`
- Include both `includeCompleted` and `includeArchived`

**Tool 7: `linear_get_agent_sessions`**

- Input: `{ first?, after?, before?, last?, includeArchived?, orderBy? }`
- Return paginated agent session list

**Tool 8: `linear_get_agent_session`**

- Input: `{ sessionId }`
- Return detailed session payload

#### Callback interface

```ts
interface T3ToolsCallbacks {
  readonly parentThreadId?: string;
  readonly parentProjectId?: string;
  readonly onSessionCreated?: (childLinearSessionId: string, parentThreadId: string) => void;
  readonly onFeedbackDelivery?: (childLinearSessionId: string, message: string) => Promise<boolean>;
}
```

#### Files to create

1. `apps/server/src/mcp/t3Tools.ts`

#### Files to modify

1. `apps/server/src/linear/Layers/LinearClient.ts`
2. `apps/server/src/linear/Services/LinearClient.ts`

#### Linear client additions

Extend the Linear client layer with any raw GraphQL helpers needed for:

1. `agentSessionCreateOnIssue`
2. `agentSessionCreateOnComment`
3. `agentSessions(...)`
4. issue project-key lookup for routing

---

### 1c. MCP HTTP Route + Context Registry

**Create `apps/server/src/mcp/Layers/McpToolsRoute.ts`**

Expose `POST /mcp/t3-tools` using `StreamableHTTPServerTransport`.

#### Context identity

Do **not** key MCP context by thread id alone. Match Cyrus's composite scoping by using the T3 project plus parent thread:

```ts
const contextId = `${projectId}:${parentThreadId}`;
```

That is the T3 Code analogue of Cyrus's `repoId:parentSessionId`.

#### Request headers

```http
x-t3-mcp-context-id: {projectId}:{parentThreadId}
Authorization: Bearer {T3CODE_AUTH_TOKEN}
mcp-session-id: {uuid}
```

#### Files to create

1. `apps/server/src/mcp/Services/McpContextRegistry.ts`
2. `apps/server/src/mcp/Layers/McpContextRegistry.ts`
3. `apps/server/src/mcp/Layers/McpToolsRoute.ts`

#### Files to modify

1. `apps/server/src/server.ts`

---

### 1d. Parent-Child Relationship Tracking

**Create migration `apps/server/src/persistence/Migrations/021_ThreadRelationships.ts``**

The schema must support two-phase registration and idempotent parent resume.

```sql
CREATE TABLE IF NOT EXISTS thread_relationships (
  id TEXT PRIMARY KEY,
  parent_thread_id TEXT NOT NULL,
  child_thread_id TEXT,
  child_linear_session_id TEXT NOT NULL UNIQUE,
  child_issue_identifier TEXT,
  child_worktree_path TEXT,
  relationship_type TEXT NOT NULL DEFAULT 'delegated-task',
  last_resumed_child_turn_id TEXT,
  attached_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_thread_relationships_parent ON thread_relationships(parent_thread_id);
CREATE INDEX idx_thread_relationships_child ON thread_relationships(child_thread_id);
CREATE INDEX idx_thread_relationships_child_session ON thread_relationships(child_linear_session_id);
```

#### Why this differs from the old draft

1. `child_thread_id` must be nullable during phase 1
2. `child_linear_session_id` must be unique because it is the stable bridge across the webhook boundary
3. `last_resumed_child_turn_id` is needed to avoid duplicate parent resumes
4. `child_worktree_path` is needed so the parent can verify child work

#### Service

**Create `apps/server/src/mcp/Services/ThreadRelationshipRegistry.ts`**  
**Create `apps/server/src/mcp/Layers/ThreadRelationshipRegistry.ts`**

Service shape:

```ts
interface ThreadRelationshipRegistryShape {
  registerFromMcp(entry): Effect<void>;
  attachChildThread(input): Effect<void>;
  listChildren(parentThreadId): Effect<ReadonlyArray<...>>;
  findParent(childThreadId): Effect<Option<...>>;
  findParentByLinearSession(childLinearSessionId): Effect<Option<...>>;
  markResumed(childThreadId, childTurnId): Effect<boolean>; // false => already resumed
  updateChildWorktree(childThreadId, childWorktreePath): Effect<void>;
  remove(parentThreadId, childThreadId): Effect<void>;
}
```

#### Files to modify

1. `apps/server/src/linear/Layers/LinearWebhookHandler.ts`
2. `apps/server/src/persistence/Migrations.ts`

---

### 1e. Child Completion → Parent Resume

**Create `apps/server/src/mcp/Layers/ChildCompletionReactor.ts`**

Use turn-completion semantics, not session-stop semantics.

#### Detection strategy

Use a per-turn signal so parent resumes are idempotent:

1. Listen for child `turn.completed` runtime events or `thread.turn-diff-completed`
2. Resolve the child thread's parent relationship
3. Call `markResumed(childThreadId, childTurnId)`
4. If `markResumed` returns `false`, skip because this turn already resumed the parent

Handle child error turns separately by listening for `thread.session-set` transitions to `error` and guarding them with the same last-resumed-turn logic when possible.

#### Parent resume payload

Resume the parent with:

```md
## Child task completed

Issue: {childIssueIdentifier}
Child worktree: {childWorktreePath}
Status: completed

---

{lastAssistantMessage}

---

Review the child's work inside the child worktree and decide next steps.
```

#### Provider parity requirement

The parent must be able to access the child worktree on resume.

Add an optional field to the turn/provider pipeline:

```ts
additionalDirectories?: string[]
```

Thread it through:

1. `packages/contracts/src/orchestration.ts`
2. `packages/contracts/src/provider.ts` if needed by the provider command boundary
3. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
4. `apps/server/src/provider/Layers/ClaudeAdapter.ts`
5. `apps/server/src/provider/Layers/CodexAdapter.ts`
6. `apps/server/src/codexAppServerManager.ts` if Codex needs explicit handling

Behavior:

1. Claude: pass `[cwd, ...additionalDirectories]` to `additionalDirectories`
2. Codex: if no extra handling is needed, still thread the field through so the interface stays provider-neutral

This is required so the parent can actually verify child work like Cyrus does.

---

### 1f. Feedback Delivery

When `linear_agent_give_feedback` is called:

1. Resolve the child by `childLinearSessionId`
2. Post a child activity in Linear
3. Start a new turn on the child thread with:

```md
## Received feedback from orchestrator

---

{message}

---
```

If the parent issue identifier is known, include it in the Linear thought/body the same way Cyrus does.

#### Files to modify

1. `apps/server/src/mcp/t3Tools.ts`
2. `apps/server/src/mcp/Layers/ChildCompletionReactor.ts`

---

### 1g. MCP Config Injection

Phase 0 already established that T3 Code must support both Codex and Claude MCP discovery.

#### Requirement

Always write the merged MCP config to:

1. `{worktreePath}/.mcp.json`
2. `{worktreePath}/.codex/mcp.json`

#### Config shape

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer {LINEAR_API_TOKEN}"
      }
    },
    "t3-tools": {
      "type": "http",
      "url": "http://127.0.0.1:{PORT}/mcp/t3-tools",
      "headers": {
        "x-t3-mcp-context-id": "{projectId}:{parentThreadId}",
        "Authorization": "Bearer {T3CODE_AUTH_TOKEN}"
      }
    },
    "t3-docs": {
      "type": "http",
      "url": "http://127.0.0.1:{PORT}/mcp/t3-docs",
      "headers": {
        "Authorization": "Bearer {T3CODE_AUTH_TOKEN}"
      }
    }
  }
}
```

#### Policy

Include both `t3-tools` and `t3-docs` for **all** Linear-triggered sessions, not just orchestrators, matching the broad non-Slack MCP availability Cyrus gives to `cyrus-tools` and `cyrus-docs`.

#### Files to modify

1. `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`

---

### 1h. Orchestrator Prompt Activation + Routing Context

#### Hardcoded orchestrator label rule

Keep the Cyrus rule:

1. `orchestrator` label always maps to `orchestrator.md`
2. This should work even if no repo-specific prompt config exists

#### Additional prompt-mode parity rules

Match Cyrus label behavior, not just the orchestrator happy path:

1. `graphite-orchestrator` wins when both the graphite label and orchestrator label are present
2. `scoper` can be selected by its configured label set
3. repo/project order is deterministic and first match wins, with conflict logging
4. hardcoded `orchestrator` fallback still applies when no project-specific prompt config exists
5. post a Linear activity/thought when a label switches the session into one of these modes, matching Cyrus's "Entering '<mode>' mode..." UX

#### Routing context

Generate `<repository_routing_context>` from T3 Code projects plus `linearProjectMappings`.

#### Files to modify

1. `apps/server/src/linear/Layers/LinearPromptAssembler.ts`
2. `apps/server/src/linear/prompts/orchestrator.md`
3. `apps/server/src/linear/prompts/scoper.md`
4. `apps/server/src/linear/prompts/graphite-orchestrator.md`
5. `apps/server/src/linear/prompts/todolist-system-prompt-extension.md`
6. `apps/server/src/linear/prompts/standard-issue-assigned-user-prompt.md`

#### Prompt updates

Replace all `mcp__cyrus-tools__*` references with `mcp__t3-tools__*`, including:

1. `linear_agent_session_create`
2. `linear_agent_session_create_on_comment`
3. `linear_agent_give_feedback`
4. `linear_get_agent_sessions`
5. `linear_get_agent_session`

Make the routing section talk about T3 Code projects/workspaces instead of Cyrus repository configs.

Also port the non-orchestrator prompt files and their semantics:

1. Copy/adapt `scoper.md`
2. Copy/adapt `graphite-orchestrator.md`
3. Copy/adapt `todolist-system-prompt-extension.md`
4. Preserve the existing Cyrus-style standard issue prompt template structure

### Prompt-mode tool policy parity

Cyrus does not just change the system prompt by label. It also changes the allowed/disallowed tool set for the session based on prompt type and repository config.

T3 Code needs a backend-native equivalent so prompt modes are actually enforceable.

#### Requirements

1. Introduce a `PromptType` union aligned with Cyrus:
   - `builder`
   - `debugger`
   - `scoper`
   - `orchestrator`
   - `graphite-orchestrator`
2. Add a shared tool-policy resolver that decides:
   - workspace MCP tool prefixes always included
   - prompt-type-specific allowed tool presets
   - optional disallowed tools
3. Treat `graphite-orchestrator` like `orchestrator` for tool-policy inheritance, matching Cyrus
4. Make the workspace MCP set always include:
   - `mcp__linear`
   - `mcp__t3-tools`
   - `mcp__t3-docs`
5. Preserve provider parity:
   - Claude gets explicit allowed/disallowed tool config where supported
   - Codex gets the closest supported equivalent without silently dropping MCP availability
6. Match Cyrus multi-repo semantics when more than one project/workspace is in scope:
   - allowed tools are the **union**
   - disallowed tools are the **intersection**
   - workspace MCP tools are added once and de-duped

#### T3 adaptation

Because T3 Code does not have Cyrus `RepositoryConfig`, store prompt-mode tool policy in the same `linearProjectMappings` record that already owns routing metadata.

Do **not** split prompt selection and tool selection across unrelated sources. They should resolve from the same project/workspace context so prompt mode, tool policy, and routing stay coherent.

#### Files to create

1. `apps/server/src/provider/Services/ToolPolicyResolver.ts`
2. `apps/server/src/provider/Layers/ToolPolicyResolver.ts`

#### Files to modify

1. `packages/contracts/src/provider.ts`
2. `apps/server/src/provider/Layers/ClaudeAdapter.ts`
3. `apps/server/src/provider/Layers/CodexAdapter.ts`
4. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
5. `apps/server/src/linear/Layers/LinearPromptAssembler.ts`
6. `apps/server/src/linear/Layers/LinearActivitySink.ts`

---

### 1i. Repo Selection Support in Linear Webhook Resolution

T3 Code's current `resolveMapping()` only supports:

1. labelName + optional teamKey
2. teamKey
3. defaultWorkspaceRoot

That is not enough for Cyrus-style routing parity.

#### Required changes

**Modify `apps/server/src/linear/Layers/LinearWebhookHandler.ts`**

Replace `resolveMapping(...)` with routing-aware resolution:

```ts
resolveMapping({
  organizationId,
  teamKey,
  labelNames,
  projectKeys,
  issueDescription,
  mappings,
  defaultWorkspaceRoot,
});
```

Add a sibling helper for branch resolution:

```ts
resolveBaseBranch({
  issue,
  mapping,
  parentThread,
  blockedByIssue,
});
```

Expected behavior:

1. honor `[repo=...#branch]` first
2. if graphite applies, prefer the blocking issue's branch/worktree lineage
3. otherwise inherit the parent thread branch when staying in the same project
4. otherwise fall back to mapping/default branch

#### Required data additions

**Modify `apps/server/src/linear/Services/LinearClient.ts`**  
**Modify `apps/server/src/linear/Layers/LinearClient.ts`**

Extend `LinearIssueDetails` with:

1. `projectKeys: ReadonlyArray<string>`
2. `description` already exists and should be used for repo-tag parsing
3. blocked-by relation lookup or equivalent issue relation details for graphite stack branch resolution

#### Required contract/settings changes

**Modify `packages/contracts/src/linear.ts`**  
**Modify `packages/contracts/src/settings.ts`**

Add routing metadata fields to `LinearProjectMapping`.

---

### 1j. Cyrus Task-First Behavior (builder/debugger parity)

This phase is primarily about orchestration, but if the stated goal is **Cyrus parity**, the plan must explicitly cover the Task-first builder/debugger behavior too.

#### Scope

Port the Cyrus Task-oriented expectations into T3 Code's builder/debugger prompts and runtime messaging:

1. Task-first prompt content in `builder.md` and `debugger.md`
2. Any tool/result formatting needed so Task actions render cleanly in Linear activity
3. Any provider/tool-permission wiring needed so those prompts are actually satisfiable
4. Ensure the todo/task extension is composed the same way Cyrus does for the prompt types that require it
5. Ensure `scoper` remains documentation-only and does **not** accidentally fall through to implementation behavior

If T3 Code intentionally does **not** want Task-first builder/debugger behavior, that should be called out as an explicit non-parity decision in the delta log. Otherwise, it belongs in the parity plan.

#### Files to review/modify

1. `apps/server/src/linear/prompts/builder.md`
2. `apps/server/src/linear/prompts/debugger.md`
3. `apps/server/src/linear/Layers/LinearActivitySink.ts`
4. `apps/server/src/linear/prompts/scoper.md`
5. `apps/server/src/linear/prompts/todolist-system-prompt-extension.md`
6. Provider/tool permission layers as needed

---

## Files summary

### New files

1. `apps/server/src/mcp/t3Tools.ts`
2. `apps/server/src/mcp/Services/McpContextRegistry.ts`
3. `apps/server/src/mcp/Layers/McpContextRegistry.ts`
4. `apps/server/src/mcp/Layers/McpToolsRoute.ts`
5. `apps/server/src/mcp/Services/ThreadRelationshipRegistry.ts`
6. `apps/server/src/mcp/Layers/ThreadRelationshipRegistry.ts`
7. `apps/server/src/mcp/Layers/ChildCompletionReactor.ts`
8. `apps/server/src/persistence/Migrations/021_ThreadRelationships.ts`
9. `apps/server/src/mcp/t3Docs.ts`
10. `apps/server/src/mcp/Layers/McpDocsRoute.ts`
11. `apps/server/src/provider/Services/ToolPolicyResolver.ts`
12. `apps/server/src/provider/Layers/ToolPolicyResolver.ts`
13. `apps/server/src/linear/prompts/scoper.md`
14. `apps/server/src/linear/prompts/graphite-orchestrator.md`
15. `apps/server/src/linear/prompts/todolist-system-prompt-extension.md`

### Modified files

1. `apps/server/package.json`
2. `apps/server/src/server.ts`
3. `apps/server/src/orchestration/Layers/BootstrapTurnService.ts`
4. `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
5. `apps/server/src/provider/Layers/ClaudeAdapter.ts`
6. `apps/server/src/provider/Layers/CodexAdapter.ts`
7. `apps/server/src/codexAppServerManager.ts`
8. `apps/server/src/linear/Layers/LinearWebhookHandler.ts`
9. `apps/server/src/linear/Layers/LinearPromptAssembler.ts`
10. `apps/server/src/linear/Layers/LinearClient.ts`
11. `apps/server/src/linear/Services/LinearClient.ts`
12. `apps/server/src/linear/prompts/orchestrator.md`
13. `apps/server/src/linear/prompts/builder.md`
14. `apps/server/src/linear/prompts/debugger.md`
15. `apps/server/src/linear/prompts/standard-issue-assigned-user-prompt.md`
16. `apps/server/src/linear/Layers/LinearActivitySink.ts`
17. `apps/server/src/persistence/Migrations.ts`
18. `packages/contracts/src/linear.ts`
19. `packages/contracts/src/settings.ts`
20. `packages/contracts/src/orchestration.ts`
21. `packages/contracts/src/provider.ts` if needed by the provider boundary

---

## Build sequence

```text
Step 1: Routing model first
  - Extend LinearProjectMapping with route metadata
  - Extend LinearProjectMapping with promptLabels + toolPolicy
  - Extend LinearClient issue details with project keys
  - Replace resolveMapping() with Cyrus-style routing precedence adapted to T3 projects
  - Generate repository_routing_context from T3 projects + mappings
  - Add base-branch resolution parity for graphite/parent/default branch fallbacks

Step 2: Relationship persistence
  - Add migration 021 with nullable child_thread_id and idempotency fields
  - Implement ThreadRelationshipRegistry

Step 3: T3-tools MCP server
  - Install MCP SDK
  - Implement all 8 Linear orchestration tools
  - Match Cyrus semantics for feedback and pagination

Step 4: Docs MCP parity
  - Add t3-docs MCP server and route
  - Include it anywhere Cyrus would include cyrus-docs

Step 5: MCP route and context registry
  - Build Streamable HTTP route
  - Use {projectId}:{parentThreadId} context ids

Step 6: Parent/child runtime wiring
  - Register child session ids from MCP callback
  - Attach child thread/worktree on webhook creation
  - Resume parent exactly once per child turn
  - Resume child from orchestrator feedback

Step 7: Provider parity for verification
  - Add additionalDirectories / additionalAllowedDirectories turn field
  - Ensure parent can inspect child worktree in Claude and Codex flows

Step 8: Prompt + skill parity
  - Activate orchestrator prompt with routing context
  - Port scoper and graphite-orchestrator modes
  - Port todo/task extension behavior
  - Update all prompt tool references
  - Preserve standard issue prompt structure
  - Post mode-entry activity when a label selects debugger/builder/scoper/orchestrator/graphite-orchestrator

Step 9: Tool policy parity
  - Add PromptType-aware tool policy resolver
  - Keep workspace MCP tools aligned with Cyrus parity
  - Match union/intersection behavior for multi-project sessions
  - Preserve Codex + Claude parity

Step 10: MCP config injection
  - Write both .mcp.json and .codex/mcp.json
  - Include linear, t3-tools, and t3-docs for all Linear-triggered sessions
```

## Verification

```bash
bun fmt && bun lint && bun typecheck
```

### Manual verification

1. Create at least two T3 projects, each mapped in `linearProjectMappings`
2. Create an orchestrator issue with routing context available
3. Verify the prompt includes `<repository_routing_context>`
4. Create a sub-issue routed via `[repo=...]`
5. Confirm the child webhook resolves into the correct T3 project/workspace
6. Confirm `tools/list` returns all 8 t3-tools Linear tools
7. Confirm the MCP config includes `linear`, `t3-tools`, and `t3-docs`
8. Confirm `builder`, `debugger`, `scoper`, `orchestrator`, and `graphite-orchestrator` labels pick the correct prompt mode
9. Confirm the docs MCP can answer questions from `AGENTS.md`/`docs/`
10. Confirm mode-entry activity is posted when label-based prompt selection happens
11. Confirm graphite-labeled blocked issues inherit the correct base branch ordering
12. Confirm child completion resumes the parent exactly once
13. Confirm the parent can inspect the child worktree
14. Confirm feedback resumes the child successfully

## Delta log

Add entries to `docs/t3code-delta-log.md` for:

1. T3-tools MCP server with Cyrus-parity Linear orchestration tools
2. Cyrus-style repo selection adapted to T3 Code projects
3. T3-docs MCP as the non-Slack equivalent of cyrus-docs
4. Parent-child thread relationship tracking with idempotent resume
5. Parent verification access to child worktrees across providers
6. Label-driven prompt-mode and tool-policy parity in T3 Code
7. Orchestrator prompt routing context in T3 Code
