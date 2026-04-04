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
