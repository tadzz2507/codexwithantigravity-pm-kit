import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CoordinatorStore } from "./store.js";
import { antigravityArgs, maxAttempts, retryDelaySeconds, shouldRetry, turnTimeoutMinutes } from "./worker-policy.js";

const children = new Set<ChildProcess>();
const exec = (file: string, fileArgs: string[], options: ExecFileOptionsWithStringEncoding) =>
  new Promise<{ stdout: string; stderr: string }>((resolveExec, rejectExec) => {
    const child = execFile(file, fileArgs, options, (error, stdout, stderr) => {
      children.delete(child);
      if (error) { Object.assign(error, { stdout, stderr }); rejectExec(error); }
      else resolveExec({ stdout, stderr });
    });
    children.add(child);
    child.stdin?.end();
  });
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const projectArg = value("--project");
const repositoryArg = value("--repo");
const pollSeconds = Number(value("--poll") ?? 20);
const dbPath = resolve((process.env.PM_DB_PATH ?? "~/.codex-antigravity-pm/project.db").replace(/^~(?=[/\\]|$)/, homedir()));
const logPath = value("--log");
const attemptLimit = maxAttempts();
const turnTimeout = turnTimeoutMinutes();
if (!projectArg || !repositoryArg) throw new Error("Usage: worker.js --project <id> --repo <path> [--poll 20] [--log path]");
const projectId: string = projectArg;
const repositoryPath: string = repositoryArg;
const store = new CoordinatorStore(dbPath);
let stopped = false;
const normalizePath = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const write = (message: string) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (logPath) appendFileSync(logPath, `${line}\n`, "utf8");
};
const delay = (seconds: number) => new Promise(resolveDelay => setTimeout(resolveDelay, seconds * 1000));
const attempts = new Map<string, number>();

function taskIds(status: "claimed" | "submitted"): string[] {
  return (store.listTasks(projectId, [status]) as Array<Record<string, unknown>>)
    .filter(task => status !== "claimed" || task.claimedBy === "antigravity")
    .map(task => String(task.id));
}

async function runBounded(kind: "task" | "review", id: string, run: () => Promise<void>): Promise<void> {
  const key = `${kind}:${id}`;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  try {
    await run();
    if (kind === "task" && taskIds("claimed").includes(id)) throw new Error("Worker run ended without submitting or blocking the claimed task");
    if (kind === "review" && taskIds("submitted").includes(id)) throw new Error("Review run ended without resolving the submitted task");
    attempts.delete(key);
  } catch (error) {
    if (stopped) {
      attempts.delete(key);
      write(`${kind} ${id} cancelled during worker shutdown`);
      return;
    }
    if (!shouldRetry(attempt, attemptLimit)) {
      if (kind === "task") {
        const task = store.getTask(id) as { status: string; claimedBy?: string | null };
        if (["ready", "claimed", "changes_requested"].includes(task.status)) {
          store.blockTask(id, `${kind} stopped after ${attempt} attempt(s) to prevent quota-consuming loops`, ["Inspect the worker log, fix the cause, then requeue the task manually."], task.claimedBy ?? "antigravity");
          write(`${kind} ${id} blocked after ${attempt} attempt(s); manual requeue required`);
        } else {
          write(`${kind} ${id} stopped after ${attempt} attempt(s); task is already ${task.status}`);
        }
      } else {
        // A submitted task cannot be blocked by the worker; stop the runner instead of re-reviewing forever.
        store.recordProjectEvent(projectId, "runner", "runner_failed", { kind, id, attempts: attempt, error: error instanceof Error ? error.message : String(error) });
        write(`${kind} ${id} stopped after ${attempt} attempt(s); inspect the review and restart manually`);
        stopped = true;
      }
      attempts.delete(key);
      return;
    }
    const seconds = retryDelaySeconds(attempt, pollSeconds);
    write(`${kind} ${id} failed (attempt ${attempt}/${attemptLimit}); retrying after ${seconds}s: ${error instanceof Error ? error.message : String(error)}`);
    await delay(seconds);
  }
}

async function runTask(): Promise<void> {
  const prompt = `Use the codex-antigravity-pm MCP for project ${projectId}. The only repository is ${repositoryPath}. If a task is already claimed by antigravity, continue that exact task; otherwise call task_next and claim exactly one highest-priority task. Read the full specification before editing. Call task_progress at 0 percent before edits, then after discovery, implementation, and verification. You may modify only repository-relative files matched by scopeIn. Never modify scopeOut, .git, git config, sibling directories, user/global configuration, credentials, secrets, or generated caches unless the task explicitly includes them. Do not follow symlinks outside the repository. Do not create tasks, change task scope, install dependencies, commit, push, or perform unrelated refactors. Run every verification command exactly as specified. Finish by calling task_submit with changed files, tests, risks, and one evidence result for every acceptance criterion. If work cannot continue, call task_block with the exact reason and needs. Do not start a second task in this run.`;
  write("Starting Antigravity task run");
  const result = await exec("agy", antigravityArgs(prompt, turnTimeout), {
    cwd: repositoryPath, windowsHide: true, timeout: (turnTimeout * 60 + 1) * 1000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8"
  });
  if (result.stdout.trim()) write(result.stdout.trim());
  if (result.stderr.trim()) write(`stderr: ${result.stderr.trim()}`);
}

async function runReview(): Promise<void> {
  const prompt = `Use antigravity_pm as the authoritative ledger. Review every submitted task for project ${projectId}. Inspect the actual repository changes and run or verify the specified commands. Approve only when every acceptance criterion and test passes. Otherwise call task_review with request_changes, precise findings, and next actions. Do not edit implementation files and do not create unrelated tasks. After reviews, call project_status and report the remaining work.`;
  write("Starting Codex review run");
  const result = await exec("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "--approve-for-me", "-s", "workspace-write", "-C", repositoryPath, prompt], {
    cwd: repositoryPath, windowsHide: true, timeout: 31 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8"
  });
  if (result.stdout.trim()) write(result.stdout.trim());
  if (result.stderr.trim()) write(`stderr: ${result.stderr.trim()}`);
}

async function main(): Promise<void> {
  const project = store.getProject(projectId) as { repositoryPath?: string | null };
  if (project.repositoryPath && normalizePath(project.repositoryPath) !== normalizePath(repositoryPath)) {
    throw new Error(`Runner repository does not match project repositoryPath: ${project.repositoryPath}`);
  }
  store.recordProjectEvent(projectId, "runner", "runner_started", { repositoryPath: resolve(repositoryPath) });
  write(`Worker active for ${projectId} at ${repositoryPath}`);
  while (!stopped) {
    const status = store.status(projectId) as { state: string; total: number; counts: Record<string, number> };
    if (status.state === "completed") {
      store.recordProjectEvent(projectId, "runner", "runner_completed", {});
      write("Project complete; worker stopped");
      break;
    }
    if (status.state === "needs_attention") {
      store.recordProjectEvent(projectId, "runner", "runner_needs_attention", {});
      write("Project needs attention; worker stopped");
      break;
    }
    if ((status.counts.submitted ?? 0) > 0) {
      const id = taskIds("submitted")[0];
      if (id) await runBounded("review", id, runReview);
      else await delay(1);
      continue;
    }
    const id = taskIds("claimed")[0] ?? (store.nextTasks(projectId, 1, "antigravity")[0] as Record<string, unknown> | undefined)?.id;
    if (id) await runBounded("task", String(id), runTask);
    else await delay(pollSeconds);
  }
  store.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  stopped = true;
  for (const child of children) child.kill();
  write(`Received ${signal}; stopped ${children.size} child process(es)`);
});
void main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  try { store.recordProjectEvent(projectId, "runner", "runner_failed", { error: message }); } catch { }
  write(message);
  store.close();
  process.exitCode = 1;
});
