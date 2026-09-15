import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "manager" | "worker" | "viewer";
export type TaskStatus = "ready" | "claimed" | "submitted" | "approved" | "changes_requested" | "blocked";
export type SessionStatus = "online" | "busy" | "idle" | "ended";

export interface ProjectInput {
  name: string;
  outcome: string;
  repositoryPath?: string;
  constraints?: string[];
  definitionOfDone: string[];
}

export interface TaskInput {
  projectId: string;
  title: string;
  objective: string;
  context?: string;
  scopeIn: string[];
  scopeOut?: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  dependencies?: string[];
  priority?: number;
  assignee?: string;
}

export interface SubmissionInput {
  summary: string;
  changedFiles?: string[];
  artifacts?: string[];
  tests: Array<{ command: string; result: "passed" | "failed" | "not_run"; details?: string }>;
  acceptanceResults: Array<{ criterion: string; result: "passed" | "failed"; evidence: string }>;
  risks?: string[];
}

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? []);
const parse = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const cleanPath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
const matchesPathRule = (file: string, rule: string): boolean => {
  const target = cleanPath(file);
  const pattern = cleanPath(rule);
  if (!pattern || pattern === "." || pattern === "*") return true;
  if (pattern.endsWith("/**")) return target === pattern.slice(0, -3) || target.startsWith(`${pattern.slice(0, -3)}/`);
  if (pattern.includes("*")) {
    const regex = new RegExp(`^${pattern.split("*").map(part => part.replace(/[.+?^${}()|[\\]\\]/g, "\\$&")).join(".*")}(?:/.*)?$`);
    return regex.test(target);
  }
  return target === pattern || target.startsWith(`${pattern}/`);
};

export class CoordinatorStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, outcome TEXT NOT NULL,
        repository_path TEXT, constraints_json TEXT NOT NULL,
        definition_of_done_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
        objective TEXT NOT NULL, context TEXT NOT NULL, scope_in_json TEXT NOT NULL,
        scope_out_json TEXT NOT NULL, acceptance_json TEXT NOT NULL, verification_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL, priority INTEGER NOT NULL, assignee TEXT NOT NULL,
        status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, claimed_by TEXT,
        submission_json TEXT, review_json TEXT, progress_percent INTEGER NOT NULL DEFAULT 0,
        progress_note TEXT NOT NULL DEFAULT '', heartbeat_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT,
        actor TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, role TEXT NOT NULL, actor TEXT NOT NULL,
        project_id TEXT, task_id TEXT, status TEXT NOT NULL,
        started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON agent_sessions(status, heartbeat_at);
    `);
    for (const migration of [
      "ALTER TABLE tasks ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN progress_note TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE tasks ADD COLUMN heartbeat_at TEXT"
    ]) { try { this.db.exec(migration); } catch (error) { if (!String(error).includes("duplicate column name")) throw error; } }
  }

  close(): void { this.db.close(); }

  startSession(client: string, role: Role, actor: string): unknown {
    const id = `ses_${randomUUID().slice(0, 8)}`;
    const timestamp = now();
    this.db.prepare(`INSERT INTO agent_sessions(id,client,role,actor,status,started_at,heartbeat_at)
      VALUES(?,?,?,?,?,?,?)`).run(id, client, role, actor, "online", timestamp, timestamp);
    return this.getSession(id);
  }

  heartbeatSession(sessionId: string, input: { projectId?: string; taskId?: string; status?: SessionStatus } = {}): unknown {
    this.getSession(sessionId);
    this.db.prepare(`UPDATE agent_sessions SET project_id=COALESCE(?,project_id),task_id=?,status=?,heartbeat_at=?,ended_at=NULL WHERE id=?`)
      .run(input.projectId ?? null, input.taskId ?? null, input.status ?? "online", now(), sessionId);
    return this.getSession(sessionId);
  }

  touchSession(sessionId: string): void {
    this.db.prepare("UPDATE agent_sessions SET heartbeat_at=? WHERE id=? AND status!='ended'").run(now(), sessionId);
  }

  endSession(sessionId: string): void {
    const timestamp = now();
    this.db.prepare("UPDATE agent_sessions SET status='ended',heartbeat_at=?,ended_at=? WHERE id=?")
      .run(timestamp, timestamp, sessionId);
  }

  getSession(sessionId: string): unknown {
    const row = this.db.prepare("SELECT * FROM agent_sessions WHERE id=?").get(sessionId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    return this.mapSession(row);
  }

  listSessions(projectId?: string, includeEnded = false, staleAfterSeconds = 120): unknown[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (projectId) { clauses.push("project_id=?"); params.push(projectId); }
    if (!includeEnded) clauses.push("status!='ended'");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM agent_sessions ${where} ORDER BY heartbeat_at DESC`).all(...params) as Array<Record<string, unknown>>;
    const staleBefore = Date.now() - staleAfterSeconds * 1000;
    return rows.map(row => {
      const session = this.mapSession(row) as Record<string, unknown>;
      return { ...session, effectiveStatus: row.status !== "ended" && Date.parse(String(row.heartbeat_at)) < staleBefore ? "stale" : row.status };
    });
  }

  health(staleAfterSeconds = 120): unknown {
    const sessions = this.listSessions(undefined, false, staleAfterSeconds) as Array<Record<string, unknown>>;
    return {
      database: "ok", schemaVersion: 2, sessions,
      counts: sessions.reduce<Record<string, number>>((counts, session) => {
        const status = String(session.effectiveStatus);
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {})
    };
  }

  private event(projectId: string, taskId: string | null, actor: string, action: string, payload: unknown): void {
    this.db.prepare("UPDATE projects SET updated_at=? WHERE id=?").run(now(), projectId);
    this.db.prepare("INSERT INTO events(project_id,task_id,actor,action,payload_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(projectId, taskId, actor, action, json(payload), now());
  }

  createProject(input: ProjectInput, actor: string): unknown {
    const id = `prj_${randomUUID().slice(0, 8)}`;
    const timestamp = now();
    this.db.prepare(`INSERT INTO projects(id,name,outcome,repository_path,constraints_json,definition_of_done_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, input.name, input.outcome, input.repositoryPath ?? null,
        json(input.constraints), json(input.definitionOfDone), timestamp, timestamp);
    this.event(id, null, actor, "project_created", input);
    return this.getProject(id);
  }

  getProject(projectId: string): unknown {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return {
      id: row.id, name: row.name, outcome: row.outcome, repositoryPath: row.repository_path,
      constraints: parse(row.constraints_json, []), definitionOfDone: parse(row.definition_of_done_json, []),
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  listProjects(repositoryPath?: string): unknown[] {
    const rows = repositoryPath
      ? this.db.prepare("SELECT * FROM projects WHERE repository_path=? ORDER BY updated_at DESC").all(repositoryPath)
      : this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all();
    return (rows as Array<Record<string, unknown>>).map(row => ({
      id: row.id, name: row.name, outcome: row.outcome, repositoryPath: row.repository_path,
      createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  createTask(input: TaskInput, actor: string): unknown {
    this.getProject(input.projectId);
    const deps = input.dependencies ?? [];
    this.validateDependencies(input.projectId, deps);
    const id = `tsk_${randomUUID().slice(0, 8)}`;
    const timestamp = now();
    this.db.prepare(`INSERT INTO tasks(id,project_id,title,objective,context,scope_in_json,scope_out_json,acceptance_json,
      verification_json,dependencies_json,priority,assignee,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.projectId, input.title, input.objective, input.context ?? "", json(input.scopeIn),
        json(input.scopeOut), json(input.acceptanceCriteria), json(input.verificationCommands), json(deps),
        input.priority ?? 50, input.assignee ?? "antigravity", "ready", timestamp, timestamp
      );
    this.event(input.projectId, id, actor, "task_created", input);
    return this.getTask(id);
  }

  updateTaskSpec(taskId: string, patch: Partial<Omit<TaskInput, "projectId"> & { status: "ready" }>, actor: string): unknown {
    const task = this.rawTask(taskId);
    if (!["ready", "changes_requested", "blocked"].includes(String(task.status))) throw new Error(`Cannot edit a task in status ${task.status}`);
    const dependencies = patch.dependencies ?? parse<string[]>(task.dependencies_json, []);
    this.validateDependencies(String(task.project_id), dependencies, taskId);
    const fields: Record<string, unknown> = {
      title: patch.title ?? task.title, objective: patch.objective ?? task.objective,
      context: patch.context ?? task.context, scope_in_json: patch.scopeIn ? json(patch.scopeIn) : task.scope_in_json,
      scope_out_json: patch.scopeOut ? json(patch.scopeOut) : task.scope_out_json,
      acceptance_json: patch.acceptanceCriteria ? json(patch.acceptanceCriteria) : task.acceptance_json,
      verification_json: patch.verificationCommands ? json(patch.verificationCommands) : task.verification_json,
      dependencies_json: json(dependencies),
      priority: patch.priority ?? task.priority, assignee: patch.assignee ?? task.assignee,
      status: patch.status ?? task.status
    };
    this.db.prepare(`UPDATE tasks SET title=?,objective=?,context=?,scope_in_json=?,scope_out_json=?,acceptance_json=?,
      verification_json=?,dependencies_json=?,priority=?,assignee=?,status=?,updated_at=? WHERE id=?`).run(
        String(fields.title), String(fields.objective), String(fields.context), String(fields.scope_in_json), String(fields.scope_out_json),
        String(fields.acceptance_json), String(fields.verification_json), String(fields.dependencies_json), Number(fields.priority),
        String(fields.assignee), String(fields.status), now(), taskId
      );
    this.event(String(task.project_id), taskId, actor, "task_spec_updated", patch);
    return this.getTask(taskId);
  }

  claimTask(taskId: string, actor: string): unknown {
    const task = this.rawTask(taskId);
    if (!["ready", "changes_requested"].includes(String(task.status))) throw new Error(`Task is not claimable: ${task.status}`);
    const dependencies = parse<string[]>(task.dependencies_json, []);
    for (const dep of dependencies) if (this.rawTask(dep).status !== "approved") throw new Error(`Dependency ${dep} is not approved`);
    const result = this.db.prepare(`UPDATE tasks SET status='claimed',claimed_by=?,progress_percent=0,
      progress_note='',heartbeat_at=?,updated_at=? WHERE id=? AND status IN ('ready','changes_requested')`)
      .run(actor, now(), now(), taskId);
    if (result.changes !== 1) throw new Error("Task was claimed by another worker");
    this.event(String(task.project_id), taskId, actor, "task_claimed", {});
    return this.getTask(taskId);
  }

  requeueTask(taskId: string, reason: string, actor: string, force = false, staleAfterSeconds = 180): unknown {
    const task = this.rawTask(taskId);
    if (!['claimed', 'blocked'].includes(String(task.status))) throw new Error(`Only claimed or blocked tasks can be requeued; current status: ${task.status}`);
    if (task.status === 'claimed' && !force && this.hasLiveWorker(taskId, staleAfterSeconds)) {
      throw new Error(`Task ${taskId} still has a live worker session`);
    }
    this.db.prepare(`UPDATE tasks SET status='ready',claimed_by=NULL,progress_percent=0,progress_note='',heartbeat_at=NULL,updated_at=? WHERE id=?`)
      .run(now(), taskId);
    this.event(String(task.project_id), taskId, actor, 'task_requeued', { reason, force });
    return this.getTask(taskId);
  }

  recoverProject(projectId: string, staleAfterSeconds: number, actor: string): unknown {
    const claimed = this.listTasks(projectId, ['claimed']) as Array<Record<string, unknown>>;
    const recovered: string[] = [];
    for (const task of claimed) {
      const taskId = String(task.id);
      if (!this.hasLiveWorker(taskId, staleAfterSeconds)) {
        this.requeueTask(taskId, `No live worker session within ${staleAfterSeconds}s`, actor);
        recovered.push(taskId);
      }
    }
    return { projectId, recovered, status: this.status(projectId, staleAfterSeconds) };
  }

  submitTask(taskId: string, submission: SubmissionInput, actor: string): unknown {
    const task = this.rawTask(taskId);
    if (task.status !== "claimed") throw new Error(`Task must be claimed before submission; current status: ${task.status}`);
    if (task.claimed_by !== actor) throw new Error(`Task is claimed by ${task.claimed_by}, not ${actor}`);
    if ((submission.changedFiles?.length ?? 0) + (submission.artifacts?.length ?? 0) === 0) throw new Error("Submission must include at least one changed file or artifact");
    if (!submission.tests.length) throw new Error("Submission must include test or verification results");
    const scopeIn = parse<string[]>(task.scope_in_json, []);
    const scopeOut = parse<string[]>(task.scope_out_json, []);
    for (const file of submission.changedFiles ?? []) {
      if (scopeOut.some(rule => matchesPathRule(file, rule))) throw new Error(`Changed file is explicitly out of scope: ${file}`);
      if (!scopeIn.some(rule => matchesPathRule(file, rule))) throw new Error(`Changed file is outside scopeIn: ${file}`);
    }
    const criteria = parse<string[]>(task.acceptance_json, []);
    const submittedCriteria = new Set(submission.acceptanceResults.map(item => item.criterion));
    const missing = criteria.filter(item => !submittedCriteria.has(item));
    if (missing.length) throw new Error(`Missing acceptance evidence for: ${missing.join("; ")}`);
    this.db.prepare(`UPDATE tasks SET status='submitted',submission_json=?,revision=revision+1,
      progress_percent=100,progress_note='Submitted for review',heartbeat_at=?,updated_at=? WHERE id=?`)
      .run(json(submission), now(), now(), taskId);
    this.event(String(task.project_id), taskId, actor, "task_submitted", submission);
    return this.getTask(taskId);
  }

  blockTask(taskId: string, reason: string, needs: string[], actor: string): unknown {
    const task = this.rawTask(taskId);
    if (!["claimed", "ready", "changes_requested"].includes(String(task.status))) throw new Error(`Cannot block task in status ${task.status}`);
    if (task.status === "claimed" && task.claimed_by !== actor) throw new Error(`Task is claimed by ${task.claimed_by}, not ${actor}`);
    this.db.prepare("UPDATE tasks SET status='blocked',claimed_by=NULL,heartbeat_at=NULL,updated_at=? WHERE id=?").run(now(), taskId);
    this.event(String(task.project_id), taskId, actor, "task_blocked", { reason, needs });
    return this.getTask(taskId);
  }

  updateTaskProgress(taskId: string, percent: number, note: string, actor: string): unknown {
    const task = this.rawTask(taskId);
    if (task.status !== "claimed") throw new Error(`Only claimed tasks can report progress; current status: ${task.status}`);
    if (task.claimed_by !== actor) throw new Error(`Task is claimed by ${task.claimed_by}, not ${actor}`);
    if (percent < Number(task.progress_percent ?? 0)) throw new Error(`Progress cannot decrease from ${task.progress_percent} to ${percent}`);
    const timestamp = now();
    this.db.prepare("UPDATE tasks SET progress_percent=?,progress_note=?,heartbeat_at=?,updated_at=? WHERE id=?")
      .run(percent, note, timestamp, timestamp, taskId);
    this.event(String(task.project_id), taskId, actor, "task_progress", { percent, note });
    return this.getTask(taskId);
  }

  reviewTask(taskId: string, decision: "approve" | "request_changes", findings: string[], nextActions: string[], actor: string): unknown {
    const task = this.rawTask(taskId);
    if (task.status !== "submitted") throw new Error(`Only submitted tasks can be reviewed; current status: ${task.status}`);
    if (decision === "request_changes" && findings.length === 0) throw new Error("Changes requested requires at least one finding");
    const status = decision === "approve" ? "approved" : "changes_requested";
    const review = { decision, findings, nextActions, reviewedBy: actor, reviewedAt: now() };
    this.db.prepare("UPDATE tasks SET status=?,review_json=?,updated_at=? WHERE id=?").run(status, json(review), now(), taskId);
    this.event(String(task.project_id), taskId, actor, `task_${status}`, review);
    return this.getTask(taskId);
  }

  listTasks(projectId: string, statuses?: TaskStatus[]): unknown[] {
    this.getProject(projectId);
    const rows = statuses?.length
      ? this.db.prepare(`SELECT id FROM tasks WHERE project_id=? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY priority ASC,created_at ASC`).all(projectId, ...statuses)
      : this.db.prepare("SELECT id FROM tasks WHERE project_id=? ORDER BY priority ASC,created_at ASC").all(projectId);
    return (rows as Array<{ id: string }>).map(row => this.getTask(row.id));
  }

  nextTasks(projectId: string, limit = 5): unknown[] {
    const candidates = this.listTasks(projectId, ["ready", "changes_requested"]) as Array<Record<string, unknown>>;
    return candidates.filter(task => (task.dependencies as string[]).every(dep => this.rawTask(dep).status === "approved")).slice(0, limit);
  }

  status(projectId: string, staleAfterSeconds = 180): unknown {
    const tasks = this.listTasks(projectId) as Array<Record<string, unknown>>;
    const sessions = this.listSessions(projectId, false, staleAfterSeconds) as Array<Record<string, unknown>>;
    const counts: Record<string, number> = {};
    for (const task of tasks) counts[String(task.status)] = (counts[String(task.status)] ?? 0) + 1;
    const alerts = tasks.filter(task => task.status === 'claimed' && !this.hasLiveWorker(String(task.id), staleAfterSeconds))
      .map(task => ({ type: 'stale_claim', taskId: task.id, message: 'Claimed task has no live worker; use project_recover or task_requeue.' }));
    return {
      project: this.getProject(projectId), counts, total: tasks.length,
      active: tasks.filter(task => task.status === "claimed").map(task => ({ id: task.id, title: task.title,
        progressPercent: task.progressPercent, progressNote: task.progressNote, heartbeatAt: task.heartbeatAt })),
      nextActionable: this.nextTasks(projectId, 10),
      workers: sessions.filter(session => session.role === 'worker'), alerts
    };
  }

  events(projectId: string, limit = 50): unknown[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE project_id=? ORDER BY id DESC LIMIT ?").all(projectId, limit) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: row.id, taskId: row.task_id, actor: row.actor, action: row.action, payload: parse(row.payload_json, {}), createdAt: row.created_at }));
  }

  getTask(taskId: string): unknown {
    const row = this.rawTask(taskId);
    return {
      id: row.id, projectId: row.project_id, title: row.title, objective: row.objective, context: row.context,
      scopeIn: parse(row.scope_in_json, []), scopeOut: parse(row.scope_out_json, []),
      acceptanceCriteria: parse(row.acceptance_json, []), verificationCommands: parse(row.verification_json, []),
      dependencies: parse(row.dependencies_json, []), priority: row.priority, assignee: row.assignee,
      status: row.status, revision: row.revision, claimedBy: row.claimed_by,
      submission: parse(row.submission_json, null), review: parse(row.review_json, null),
      progressPercent: row.progress_percent ?? 0, progressNote: row.progress_note ?? "", heartbeatAt: row.heartbeat_at ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  private rawTask(taskId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return row;
  }

  private validateDependencies(projectId: string, dependencies: string[], taskId?: string): void {
    const unique = new Set<string>();
    for (const dependency of dependencies) {
      if (unique.has(dependency)) throw new Error(`Duplicate dependency: ${dependency}`);
      unique.add(dependency);
      const row = this.db.prepare("SELECT project_id FROM tasks WHERE id=?").get(dependency) as { project_id: string } | undefined;
      if (!row || row.project_id !== projectId) throw new Error(`Invalid dependency in this project: ${dependency}`);
    }
    if (!taskId) return;
    const visiting = new Set<string>();
    const visit = (currentId: string): void => {
      if (currentId === taskId) throw new Error(`Dependency cycle includes task: ${taskId}`);
      if (visiting.has(currentId)) return;
      visiting.add(currentId);
      const row = this.rawTask(currentId);
      for (const dependency of parse<string[]>(row.dependencies_json, [])) visit(dependency);
      visiting.delete(currentId);
    };
    for (const dependency of dependencies) visit(dependency);
  }

  private hasLiveWorker(taskId: string, staleAfterSeconds: number): boolean {
    const staleBefore = new Date(Date.now() - staleAfterSeconds * 1000).toISOString();
    return Boolean(this.db.prepare(`SELECT 1 FROM agent_sessions WHERE role='worker' AND task_id=? AND status!='ended' AND heartbeat_at>=? LIMIT 1`)
      .get(taskId, staleBefore));
  }

  private mapSession(row: Record<string, unknown>): unknown {
    return {
      id: row.id, client: row.client, role: row.role, actor: row.actor,
      projectId: row.project_id, taskId: row.task_id, status: row.status,
      startedAt: row.started_at, heartbeatAt: row.heartbeat_at, endedAt: row.ended_at
    };
  }
}
