---
name: manage-antigravity-project
description: Plan and control implementation work delegated from Codex to Google Antigravity through the antigravity_pm MCP. Use when the user asks Codex to act as project manager, break a software project into tasks for Antigravity, track execution, or review Antigravity submissions.
---

# Manage Antigravity Project

Use the `antigravity_pm` tools as the authoritative task ledger. Codex is the manager; Antigravity is the worker. Do not claim that MCP directly transfers chat messages: coordination happens through tasks and evidence stored in the shared database.

## Manager workflow

1. Initialize one project with a concise outcome, repository path, constraints, and definition of done.
2. Create tasks small enough to review independently. Every task needs explicit in-scope work, out-of-scope boundaries, acceptance criteria, verification commands, dependencies, and relevant context.
3. Keep only dependency-free work in `ready`. Use dependencies to prevent Antigravity from taking work prematurely.
4. Review submitted work against every acceptance criterion and the attached evidence. Inspect the actual repository changes when available; do not approve from the summary alone.
5. Approve only when all criteria and verification checks pass. Otherwise request changes with concrete findings and next actions.
6. Report blocked tasks and unresolved review findings to the user; do not silently broaden scope.
7. Use `health_check` and `session_list` when the user asks whether agents are online, stale, or working on a task.
8. Direct the worker to call `task_progress` at meaningful milestones so Codex shows real progress rather than inferred chat activity.
9. During long work, ask the worker to call `task_progress` at meaningful milestones (for example 0, 25, 50, 75, and 100 percent) with a short note; treat `heartbeatAt` as the liveness signal.
10. If `project_status.alerts` reports `stale_claim`, call `project_recover`; use `task_requeue(force=true)` only after verifying the old worker must be replaced.

## Task quality bar

- Prefer one observable outcome per task.
- Name exact files or components when known, but allow Antigravity to discover implementation details when the repository is unfamiliar.
- State non-goals to prevent unrelated refactors.
- Verification commands must be runnable and specific.
- Acceptance criteria describe behavior, not implementation activity.
- A task is not done until its submission includes changed files or artifacts, test results, and an acceptance-criteria evidence matrix.
- Progress is not inferred from chat output; it is recorded only through `task_progress` and visible in `project_status.active`.

## Review policy

Treat `approved` as a release gate. A failed or missing test, missing evidence, scope drift, security regression, or unresolved acceptance criterion requires `changes_requested`. Include severity and file/line references when possible. Use `project_status` after reviews to identify the next actionable work.

## Session policy

- MCP process sessions are operational signals, not task completion evidence.
- A stale session means heartbeat expired; inspect the task before reassigning it.
- Do not create duplicate tasks merely because a worker session restarted.
- Prefer `project_recover` for abandoned claims. It preserves live workers and requeues only tasks without a recent worker heartbeat.
- Use `project_status`, `session_list`, `health_check`, and `event_list` in Codex for project, session, heartbeat, progress, and review visibility.
