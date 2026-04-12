# Plan: Convex Orchestrator Linear Refactor

> Source PRD: conversational architecture spec for the new fork branch using `apps/orchestrator`, Chat SDK Linear adapter, Convex Agent orchestration, and T3 Code as the execution kernel

## Summary

Build a clean-break fork where Convex becomes the control plane and T3 Code becomes the worker runtime.

This plan intentionally does **not** include legacy Linear cutover or in-place migration work. The target deployment is a new machine with fresh setup, separate from the current production environment. T3's existing web UI remains untouched and continues to serve as a worker/debug console rather than the primary operator surface.

## Architectural decisions

Durable decisions that apply across all phases:

- **Package layout**:
  - `apps/orchestrator/` is the new control-plane app
  - `apps/orchestrator/convex/` contains Convex entrypoints and generated API
  - `apps/orchestrator/src/` contains bridge clients, orchestration helpers, and vendored Chat SDK state glue
- **Primary control plane**: Convex is the canonical store for orchestration threads, execution-run metadata, parent/child relationships, and Linear thread mappings.
- **Worker runtime**: `apps/server` owns worktrees, provider sessions, terminals, git state, diffs, checkpoints, and raw execution artifacts.
- **UI scope**: `apps/web` is unchanged in v1. No Convex-aware rendering, no new orchestration UX in T3.
- **Linear integration boundary**: Chat SDK's Linear adapter handles webhook ingress and reply/reaction egress. It is not the durable workflow brain.
- **Workflow brain**: Convex Agent owns durable orchestration logic, child-run planning, and final decision-making.
- **State adapter strategy**: Do not install `convex-chat-sdk`. Vendor the minimal state-adapter behavior needed for Chat SDK lock, subscription, and KV semantics directly into `apps/orchestrator`.
- **Chat SDK compatibility note**: The Linear adapter currently exposes `botUserId` as `string | undefined`, which is slightly looser than Chat SDK's optional-property typing under `exactOptionalPropertyTypes`. Keep that mismatch documented so we can remove the narrow compatibility cast later if it starts affecting maintenance.
- **Bridge protocol**: Convex controls T3 through a small authenticated HTTP worker API. T3 emits signed, idempotent callbacks back to Convex.
- **Run topology**: One Convex control thread can spawn many T3 execution runs. Each child run is independently addressable and rolls up to a parent thread.
- **Artifact ownership**: T3 stores raw logs, terminal output, file manifests, and diffs. Convex stores summaries, foreign keys, lifecycle state, and artifact pointers.
- **Linear UX scope**: v1 Linear behavior is threaded replies, edits, and reactions only. Do not design around streaming, modals, buttons, ephemeral messages, or file uploads in Linear.
- **Deployment mode**: Clean break on a new machine. No backward-compatibility or live migration work is required in this plan.

---

## Phase 1: Control Plane Skeleton

**User stories**:
- As an operator, I can boot a new `apps/orchestrator` service beside T3.
- As the system, I have one canonical place for orchestration state.

### What to build

Create the new `apps/orchestrator` app, wire Convex into the monorepo, and stand up the minimum Chat SDK Linear entrypoint with a no-op orchestration path. Define the core control-plane models so every later slice builds on stable identifiers and lifecycle records instead of ad hoc event handling.

This phase proves that the repo can host the orchestrator app and that Linear ingress can create durable control-thread records without involving T3 yet.

### Acceptance criteria

- [ ] `apps/orchestrator` is a first-class workspace in the monorepo and participates in build/typecheck tasks.
- [ ] Convex app entrypoints exist under `apps/orchestrator/convex/` and can boot locally.
- [ ] A Linear webhook can create or update a canonical control-thread record in Convex.
- [ ] The vendored Chat SDK state adapter is present and supports the minimum lock, subscription, and KV behavior needed by the bot runtime.
- [ ] No T3 worker interaction is required for the happy path in this phase.

---

## Phase 2: Single Worker Handshake

**User stories**:
- As an orchestrator, I can start one execution run in T3 from a Convex control thread.
- As the system, I can correlate one control thread to one worker run deterministically.

### What to build

Introduce the first version of the worker bridge between Convex and T3. Convex should be able to request a worker run, T3 should allocate its internal thread/worktree/session state, and T3 should callback into Convex with stable identifiers and a small lifecycle envelope.

This is the first thin end-to-end slice through control plane, worker API, callback protocol, and durable run metadata.

### Acceptance criteria

- [ ] Convex can create one execution run through an authenticated HTTP request to T3.
- [ ] T3 returns or publishes a stable `t3ThreadId` and `executionRunId` that Convex can persist.
- [ ] T3 can callback into Convex with `started`, `completed`, and `failed` lifecycle events for a single run.
- [ ] Callback application is idempotent for repeated deliveries of the same event id.
- [ ] No Linear reply behavior is required yet beyond internal control-thread/run correlation.

---

## Phase 3: Linear Thread Reply Loop

**User stories**:
- As a Linear user, I can comment on an issue and receive a threaded reply tied to the correct issue or comment thread.
- As the system, I can tolerate duplicate webhook delivery without double-replying.

### What to build

Complete the first user-visible vertical slice: Linear webhook arrives through Chat SDK, Convex resolves or creates the control thread, Convex launches a single T3 worker run, T3 emits completion data, and Convex posts a threaded reply back into Linear.

The reply can be intentionally simple in v1, but it must be deterministic, correctly threaded, and sourced from Convex-owned run state rather than direct T3-to-Linear calls.

### Acceptance criteria

- [ ] Linear issue-thread and comment-thread routing both map to stable Convex control threads.
- [ ] One completed worker run produces exactly one threaded Linear reply.
- [ ] Duplicate Linear webhook delivery does not create duplicate control threads or duplicate replies.
- [ ] The Linear reply is generated from Convex-owned run state rather than from direct T3 webhook logic.
- [ ] The happy path is demoable without any manual data repair between systems.

---

## Phase 4: Execution State and Recovery

**User stories**:
- As an operator, I can recover run state after retries, duplicate callbacks, or worker restarts.
- As the system, I can reach a correct final state without double-applying completion behavior.

### What to build

Strengthen the worker-control protocol so Convex can reconcile eventual worker state even when callbacks are delayed, duplicated, or partially missing. Add explicit execution-run lifecycle states and a recovery path based on callback replay and status inspection.

This phase makes the architecture operationally credible before we add richer orchestration behaviors.

### Acceptance criteria

- [ ] Execution runs have explicit durable states for queued, running, completed, failed, interrupted, and unknown/reconciling.
- [ ] Duplicate callbacks do not re-open closed runs or double-trigger Linear replies.
- [ ] Convex can reconcile final worker state via polling or replay if callbacks are lost.
- [ ] Worker restarts do not orphan the control thread permanently.
- [ ] Recovery behavior is covered by deterministic tests, not only by manual verification.

---

## Phase 5: Run Continuation and Stop Control

**User stories**:
- As a Linear user, I can send follow-up comments that continue an existing worker run context.
- As a Linear user, I can stop or interrupt in-flight work.

### What to build

Add continuation and interruption semantics to the control plane. Follow-up Linear comments should route to the right control thread and either continue an active worker context or create a new run on the same control thread according to explicit policy. Stop requests should flow through Convex to T3 and produce a final, durable result state.

This phase turns the system from one-shot request/reply automation into an actual conversational execution loop.

### Acceptance criteria

- [ ] Follow-up Linear comments attach to the correct control thread.
- [ ] Convex can create a continuation run or message against the appropriate worker context.
- [ ] Stop requests result in T3 interruption and a durable interrupted state in Convex.
- [ ] The system avoids ambiguous "two active runs for one control thread" behavior unless that thread is explicitly orchestrator-managed.
- [ ] Final Linear replies after stop/interrupt are deterministic and non-duplicated.

---

## Phase 6: Parent/Child Orchestration

**User stories**:
- As an orchestrator, I can decompose work into multiple child execution runs.
- As the system, I can track child runs under one parent control thread and roll their outcomes back up.

### What to build

Introduce explicit parent/child orchestration semantics in Convex Agent. A parent control thread can plan, spawn, monitor, and summarize multiple child worker runs. Child runs remain T3-owned at the execution layer, but their relationships and aggregate status belong to Convex.

This phase should preserve the architecture decision that Convex is the orchestrator and T3 is just the execution kernel.

### Acceptance criteria

- [ ] A parent control thread can spawn multiple child execution runs with stable parent-child relationships.
- [ ] Each child run has its own lifecycle state and worker mapping.
- [ ] Parent state can summarize child status without reading from T3 UI state.
- [ ] Child completion can roll up into a parent summary or next-step orchestration decision in Convex.
- [ ] The system prevents duplicate child-run registration for the same orchestrator action.

---

## Phase 7: Artifact Metadata and Worker Observability

**User stories**:
- As an operator, I can inspect what each worker produced without moving raw artifacts into Convex.
- As the system, I can link orchestrator state to T3-owned execution artifacts cleanly.

### What to build

Add the metadata model that lets Convex reason about T3 outputs without owning heavyweight payloads. Convex should store structured summaries of diffs, outputs, terminal state, and attachments, plus stable pointers back to T3-owned artifact locations or retrieval APIs.

This phase makes the control plane useful for operational debugging and higher-level orchestration decisions while preserving the "T3 owns raw artifacts" boundary.

### Acceptance criteria

- [ ] Convex stores normalized metadata summaries for worker outputs and references raw artifacts by pointer rather than by full payload.
- [ ] Parent threads can reference child-run artifact summaries during orchestration.
- [ ] Operators can inspect run outcome metadata in Convex without needing to scrape T3 logs manually.
- [ ] The worker bridge exposes enough retrieval metadata to support future runbooks and debugging tools.
- [ ] Raw artifact storage remains entirely outside Convex.

---

## Future follow-on work

These items are intentionally out of scope for this plan:

- Machine setup guides and deployment runbooks for the new environment
- Operational dashboards and day-2 observability tooling
- Any migration or cutover plan from the current production machine
- Any future decision to make the T3 UI Convex-aware
