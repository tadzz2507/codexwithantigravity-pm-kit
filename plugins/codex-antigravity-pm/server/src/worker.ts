import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CoordinatorStore } from "./store.js";
import { maxAttempts, retryDelaySeconds, shouldRetry } from "./worker-policy.js";

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
if (!projectArg || !repositoryArg) throw new Error("Usage: worker.js --project <id> --repo <path> [--poll 20] [--log path]");
const projectId: string = projectArg;
const repositoryPath: string = repositoryArg;
const store = new CoordinatorStore(dbPath);
let stopped = false;
const write = (message: string) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (logPath) appendFileSync(logPath, `${line}\n`, "utf8");
};
const delay = (seconds: number) => new Promise(resolveDelay => setTimeout(resolveDelay, seconds * 1000));
const attempts = new Map<string, number>();

function taskIds(status: "claimed" | "submitted"): string[] {
  return (store.listTasks(projectId, [status]) as Array<Record<string, unknown>>).map(task => String(task.id));
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
  const prompt = `Use the codex-antigravity-pm MCP for project ${projectId}. If a task is already claimed by antigravity, continue that exact task; otherwise call task_next and claim exactly one highest-priority task. Read the full specification before editing. You have full authority inside scopeIn, but may not modify scopeOut or any file outside scopeIn. Do not create tasks, change task scope, install dependencies, or perform unrelated refactors. Call task_progress at meaningful milestones. Run every verification command. Finish by calling task_submit with changed files, tests, risks, and evidence for every acceptance criterion. If work cannot continue, call task_block with the exact reason and needs. Do not start a second task in this run.`;
  write("Starting Antigravity task run");
  const result = await exec("agy", ["--mode", "accept-edits", "--dangerously-skip-permissions", "--model", "gemini-3.8-flash-low", "--effort", "low", "--print-timeout", "30m", "--output-format", "text", `--print=${prompt}`], {
    cwd: repositoryPath, windowsHide: true, timeout: 31 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8"
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
  store.getProject(projectId);
  write(`Worker active for ${projectId} at ${repositoryPath}`);
  while (!stopped) {
    const status = store.status(projectId) as { total: number; counts: Record<string, number> };
    if (status.total > 0 && (status.counts.approved ?? 0) === status.total) { write("Project complete; worker stopped"); break; }
    if ((status.counts.submitted ?? 0) > 0) {
      const id = taskIds("submitted")[0];
      if (id) await runBounded("review", id, runReview);
      else await delay(1);
      continue;
    }
    if ((status.counts.claimed ?? 0) === 0 && store.nextTasks(projectId, 1).length === 0) { await delay(pollSeconds); continue; }
    const id = taskIds("claimed")[0] ?? (store.nextTasks(projectId, 1)[0] as Record<string, unknown> | undefined)?.id;
    if (id) await runBounded("task", String(id), runTask);
  }
  store.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  stopped = true;
  for (const child of children) child.kill();
  write(`Received ${signal}; stopped ${children.size} child process(es)`);
});
void main().catch(error => { write(error instanceof Error ? error.stack ?? error.message : String(error)); store.close(); process.exitCode = 1; });
