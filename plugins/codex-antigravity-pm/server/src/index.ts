import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { CoordinatorStore, type Role, type TaskStatus } from "./store.js";

function expandPath(value: string): string {
  const home = homedir();
  return resolve(value
    .replace(/^~(?=[/\\]|$)/, home)
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE ?? home)
    .replace(/\$\{HOME\}/g, process.env.HOME ?? home));
}

const role = (process.env.PM_ROLE ?? "viewer") as Role;
if (!["manager", "worker", "viewer"].includes(role)) throw new Error("PM_ROLE must be manager, worker, or viewer");
const actor = process.env.PM_ACTOR ?? role;
const dbPath = expandPath(process.env.PM_DB_PATH ?? "~/.codex-antigravity-pm/project.db");
const store = new CoordinatorStore(dbPath);
const client = process.env.PM_CLIENT ?? (role === "worker" ? "antigravity" : role === "manager" ? "codex" : role);
const session = store.startSession(client, role, actor) as { id: string };
const heartbeat = setInterval(() => store.touchSession(session.id), 30_000);
heartbeat.unref();
const scriptPath = (name: string) => fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
const runScript = (name: string, parameters: string[]) => execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath(name), ...parameters], { encoding: "utf8", windowsHide: true }).trim();

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const guarded = <T extends object>(fn: (input: T, context: ServerContext) => unknown | Promise<unknown>) => async (input: T, context: ServerContext) => {
  let projectId: string | undefined;
  try {
    const inputContext = input as Record<string, unknown>;
    projectId = typeof inputContext.projectId === "string" ? inputContext.projectId : undefined;
    const taskId = typeof inputContext.taskId === "string" ? inputContext.taskId : undefined;
    if (!projectId && taskId) projectId = (store.getTask(taskId) as { projectId: string }).projectId;
    store.heartbeatSession(session.id, { projectId, taskId, status: taskId ? "busy" : "online" });
    return text(await fn(input, context));
  }
  catch (error) {
    store.heartbeatSession(session.id, { projectId, status: "idle" });
    return { ...text({ error: error instanceof Error ? error.message : String(error) }), isError: true };
  }
};
const samePath = (left: string, right: string) => {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
};
const absoluteRepositoryPath = (value: string) => {
  if (!isAbsolute(value)) throw new Error("repositoryPath must be absolute");
  return resolve(value);
};
const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolveWait, rejectWait) => {
  if (signal.aborted) { rejectWait(new Error("project_wait cancelled")); return; }
  const onAbort = () => { clearTimeout(timer); rejectWait(new Error("project_wait cancelled")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolveWait(); }, milliseconds);
  signal.addEventListener("abort", onAbort, { once: true });
});

function createServer(): McpServer {
  const server = new McpServer(
    { name: "codex-antigravity-pm", version: "0.1.1" },
    { instructions: "Shared delivery ledger with session tracking. Managers create precise tasks and approve only after evidence review. Workers claim dependency-free tasks, report milestone progress, and submit files, tests, and evidence." }
  );

  server.registerTool("health_check", { description: "Check database and active agent sessions", inputSchema: z.object({ staleAfterSeconds: z.number().int().min(10).max(3600).default(120) }), annotations: { readOnlyHint: true } },
    guarded(({ staleAfterSeconds }) => store.health(staleAfterSeconds)));
  server.registerTool("session_list", { description: "List online, busy, stale, or ended agent sessions", inputSchema: z.object({
    projectId: z.string().optional(), includeEnded: z.boolean().default(false), staleAfterSeconds: z.number().int().min(10).max(3600).default(120)
  }), annotations: { readOnlyHint: true } }, guarded(({ projectId, includeEnded, staleAfterSeconds }) => store.listSessions(projectId, includeEnded, staleAfterSeconds)));

  server.registerTool("project_get", { description: "Read one project", inputSchema: z.object({ projectId: z.string() }), annotations: { readOnlyHint: true } },
    guarded(({ projectId }) => store.getProject(projectId)));
  server.registerTool("project_list", { description: "List managed projects, optionally filtered by repository", inputSchema: z.object({ repositoryPath: z.string().optional() }), annotations: { readOnlyHint: true } },
    guarded(({ repositoryPath }) => store.listProjects(repositoryPath)));
  server.registerTool("task_get", { description: "Read a task specification, submission, and review", inputSchema: z.object({ taskId: z.string() }), annotations: { readOnlyHint: true } },
    guarded(({ taskId }) => store.getTask(taskId)));
  server.registerTool("task_list", { description: "List project tasks, optionally filtered by status", inputSchema: z.object({
    projectId: z.string(), statuses: z.array(z.enum(["ready", "claimed", "submitted", "approved", "changes_requested", "blocked"])).optional()
  }), annotations: { readOnlyHint: true } }, guarded(({ projectId, statuses }) => store.listTasks(projectId, statuses as TaskStatus[] | undefined)));
  server.registerTool("project_status", { description: "Summarize delivery status, workers, stale claims, and dependency-free work", inputSchema: z.object({
    projectId: z.string(), staleAfterSeconds: z.number().int().min(30).max(3600).default(180)
  }), annotations: { readOnlyHint: true } }, guarded(({ projectId, staleAfterSeconds }) => store.status(projectId, staleAfterSeconds)));
  server.registerTool("project_wait", { description: "Wait briefly for project progress, completion, or required intervention", inputSchema: z.object({
    projectId: z.string(), afterEventId: z.number().int().nonnegative().optional(), waitSeconds: z.number().int().min(1).max(50).default(30),
    staleAfterSeconds: z.number().int().min(30).max(3600).default(180)
  }), annotations: { readOnlyHint: true } }, guarded(async ({ projectId, afterEventId, waitSeconds, staleAfterSeconds }, context) => {
    const deadline = Date.now() + waitSeconds * 1000;
    while (true) {
      const status = store.status(projectId, staleAfterSeconds) as { state: string; lastEvent?: { id?: number } | null };
      const latestEventId = Number(status.lastEvent?.id ?? 0);
      if (status.state === "completed" || status.state === "needs_attention") return { reason: status.state, status };
      if (afterEventId === undefined || latestEventId > afterEventId) return { reason: "event", status };
      if (Date.now() >= deadline) return { reason: "timeout", status };
      await wait(Math.min(500, deadline - Date.now()), context.mcpReq.signal);
    }
  }));
  server.registerTool("event_list", { description: "Read the audit trail for a project", inputSchema: z.object({ projectId: z.string(), limit: z.number().int().min(1).max(200).default(50) }), annotations: { readOnlyHint: true } },
    guarded(({ projectId, limit }) => store.events(projectId, limit)));

  if (role === "manager") {
    server.registerTool("project_run", { description: "Start one autonomous Codex-managed run from a goal; task details stay internal", inputSchema: z.object({
      repositoryPath: z.string().min(1), goal: z.string().min(1), name: z.string().min(1).optional(),
      scopeIn: z.array(z.string().min(1)).min(1), scopeOut: z.array(z.string()).default([]),
      acceptanceCriteria: z.array(z.string().min(1)).min(1), verificationCommands: z.array(z.string().min(1)).min(1),
      constraints: z.array(z.string()).default([]), priority: z.number().int().min(1).max(100).default(50),
      pollSeconds: z.number().int().min(5).max(300).default(20),
      turnTimeoutMinutes: z.number().int().min(10).max(480).default(120)
    }) }, guarded(input => {
      const repo = absoluteRepositoryPath(input.repositoryPath);
      const project = store.createProject({
        name: input.name ?? `Autonomous run: ${basename(input.repositoryPath)}`,
        outcome: input.goal, repositoryPath: repo,
        constraints: [...input.constraints, "Antigravity may modify only scopeIn and must not touch scopeOut."],
        definitionOfDone: input.acceptanceCriteria
      }, actor) as { id: string; repositoryPath?: string };
      const task = store.createTask({
        projectId: project.id, title: "Execute requested goal", objective: input.goal,
        context: "Managed internally by Codex. Do not create additional tasks or expand scope.",
        scopeIn: input.scopeIn, scopeOut: input.scopeOut, acceptanceCriteria: input.acceptanceCriteria,
        verificationCommands: input.verificationCommands, priority: input.priority, assignee: "antigravity"
      }, actor) as { id: string };
      const message = runScript("start-worker.ps1", ["-ProjectId", project.id, "-RepositoryPath", repo, "-DatabasePath", dbPath, "-PollSeconds", String(input.pollSeconds), "-TurnTimeoutMinutes", String(input.turnTimeoutMinutes)]);
      return { projectId: project.id, taskId: task.id, message, mode: "autonomous", next: "Call project_wait repeatedly until completed or needs_attention." };
    }));
    server.registerTool("project_init", { description: "Create a managed project", inputSchema: z.object({
      name: z.string().min(1), outcome: z.string().min(1), repositoryPath: z.string().optional(),
      constraints: z.array(z.string()).default([]), definitionOfDone: z.array(z.string().min(1)).min(1)
    }) }, guarded(input => store.createProject({ ...input, repositoryPath: input.repositoryPath ? absoluteRepositoryPath(input.repositoryPath) : undefined }, actor)));
    server.registerTool("task_create", { description: "Create a detailed implementation task for Antigravity", inputSchema: z.object({
      projectId: z.string(), title: z.string().min(1), objective: z.string().min(1), context: z.string().default(""),
      scopeIn: z.array(z.string().min(1)).min(1), scopeOut: z.array(z.string()).default([]),
      acceptanceCriteria: z.array(z.string().min(1)).min(1), verificationCommands: z.array(z.string().min(1)).min(1),
      dependencies: z.array(z.string()).default([]), priority: z.number().int().min(1).max(100).default(50), assignee: z.string().default("antigravity")
    }) }, guarded(input => store.createTask(input, actor)));
    server.registerTool("task_update_spec", { description: "Revise a ready, blocked, or changes-requested task specification", inputSchema: z.object({
      taskId: z.string(), title: z.string().min(1).optional(), objective: z.string().min(1).optional(), context: z.string().optional(),
      scopeIn: z.array(z.string().min(1)).min(1).optional(), scopeOut: z.array(z.string()).optional(),
      acceptanceCriteria: z.array(z.string().min(1)).min(1).optional(), verificationCommands: z.array(z.string().min(1)).min(1).optional(),
      dependencies: z.array(z.string()).optional(), priority: z.number().int().min(1).max(100).optional(), assignee: z.string().optional(),
      status: z.literal("ready").optional()
    }) }, guarded(({ taskId, ...patch }) => store.updateTaskSpec(taskId, patch, actor)));
    server.registerTool("task_review", { description: "Approve a submission or request precise changes", inputSchema: z.object({
      taskId: z.string(), decision: z.enum(["approve", "request_changes"]), findings: z.array(z.string()).default([]), nextActions: z.array(z.string()).default([])
    }) }, guarded(({ taskId, decision, findings, nextActions }) => store.reviewTask(taskId, decision, findings, nextActions, actor)));
    server.registerTool("task_requeue", { description: "Return a claimed or blocked task to ready; live workers are protected unless force is true", inputSchema: z.object({
      taskId: z.string(), reason: z.string().min(1), force: z.boolean().default(false),
      staleAfterSeconds: z.number().int().min(30).max(3600).default(180)
    }) }, guarded(({ taskId, reason, force, staleAfterSeconds }) => store.requeueTask(taskId, reason, actor, force, staleAfterSeconds)));
    server.registerTool("project_recover", { description: "Requeue claimed tasks that no longer have a live Antigravity worker", inputSchema: z.object({
      projectId: z.string(), staleAfterSeconds: z.number().int().min(30).max(3600).default(180)
    }) }, guarded(({ projectId, staleAfterSeconds }) => store.recoverProject(projectId, staleAfterSeconds, actor)));
    server.registerTool("project_worker_start", { description: "Start Antigravity background execution and Codex review loop for a project", inputSchema: z.object({
      projectId: z.string(), repositoryPath: z.string().optional(), pollSeconds: z.number().int().min(5).max(300).default(20),
      turnTimeoutMinutes: z.number().int().min(10).max(480).default(120)
    }) }, guarded(({ projectId, repositoryPath, pollSeconds, turnTimeoutMinutes }) => {
      const project = store.getProject(projectId) as { repositoryPath?: string };
      const repo = repositoryPath ?? project.repositoryPath;
      if (!repo) throw new Error("Project has no repositoryPath; provide repositoryPath");
      if (project.repositoryPath && !samePath(repo, project.repositoryPath)) throw new Error("repositoryPath must match the project repositoryPath");
      return { message: runScript("start-worker.ps1", ["-ProjectId", projectId, "-RepositoryPath", absoluteRepositoryPath(repo), "-DatabasePath", dbPath, "-PollSeconds", String(pollSeconds), "-TurnTimeoutMinutes", String(turnTimeoutMinutes)]) };
    }));
    server.registerTool("project_worker_status", { description: "Read background worker process status and recent log", inputSchema: z.object({ projectId: z.string() }), annotations: { readOnlyHint: true } },
      guarded(({ projectId }) => ({ message: runScript("worker-status.ps1", ["-ProjectId", projectId]) })));
    server.registerTool("project_worker_stop", { description: "Stop the background worker loop for a project", inputSchema: z.object({ projectId: z.string() }) },
      guarded(({ projectId }) => ({ message: runScript("stop-worker.ps1", ["-ProjectId", projectId]) })));
  }

  if (role === "worker") {
    server.registerTool("task_next", { description: "List dependency-free tasks available to Antigravity", inputSchema: z.object({ projectId: z.string(), limit: z.number().int().min(1).max(20).default(5) }), annotations: { readOnlyHint: true } },
      guarded(({ projectId, limit }) => store.nextTasks(projectId, limit, actor)));
    server.registerTool("task_claim", { description: "Claim a ready task before implementation", inputSchema: z.object({ taskId: z.string() }) },
      guarded(({ taskId }) => {
        const task = store.claimTask(taskId, actor) as { projectId: string };
        store.heartbeatSession(session.id, { projectId: task.projectId, taskId, status: "busy" });
        return task;
      }));
    server.registerTool("task_submit", { description: "Submit implementation with files, tests, and acceptance evidence", inputSchema: z.object({
      taskId: z.string(), summary: z.string().min(1), changedFiles: z.array(z.string()).default([]), artifacts: z.array(z.string()).default([]),
      tests: z.array(z.object({ command: z.string().min(1), result: z.enum(["passed", "failed", "not_run"]), details: z.string().optional() })).min(1),
      acceptanceResults: z.array(z.object({ criterion: z.string().min(1), result: z.enum(["passed", "failed"]), evidence: z.string().min(1) })).min(1),
      risks: z.array(z.string()).default([])
    }) }, guarded(({ taskId, ...submission }) => {
      const task = store.submitTask(taskId, submission, actor) as { projectId: string };
      store.heartbeatSession(session.id, { projectId: task.projectId, status: "idle" });
      return task;
    }));
    server.registerTool("task_progress", { description: "Report progress and heartbeat for a claimed task", inputSchema: z.object({
      taskId: z.string(), percent: z.number().int().min(0).max(100), note: z.string().min(1).max(2000)
    }) }, guarded(({ taskId, percent, note }) => store.updateTaskProgress(taskId, percent, note, actor)));
    server.registerTool("task_block", { description: "Mark a task blocked and state exactly what is needed", inputSchema: z.object({
      taskId: z.string(), reason: z.string().min(1), needs: z.array(z.string().min(1)).min(1)
    }) }, guarded(({ taskId, reason, needs }) => {
      const task = store.blockTask(taskId, reason, needs, actor) as { projectId: string };
      store.heartbeatSession(session.id, { projectId: task.projectId, status: "idle" });
      return task;
    }));
  }

  return server;
}

const handle = serveStdio(createServer);
console.error(`codex-antigravity-pm running as ${role}; database: ${dbPath}`);
let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  try { store.endSession(session.id); } finally {
    try { await handle.close(); } finally { store.close(); }
  }
};
process.stdin.once("close", () => { void shutdown(); });
process.once("exit", () => {
  if (!shuttingDown) {
    clearInterval(heartbeat);
    try { store.endSession(session.id); } catch { }
  }
  try { store.close(); } catch { }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void shutdown().finally(() => process.exit(0));
});
