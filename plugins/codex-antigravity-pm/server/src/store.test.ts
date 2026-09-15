import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinatorStore } from "./store.js";

test("manager-worker-review lifecycle and dependency gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Tests pass"] }, "codex") as any;
    const first = store.createTask({ projectId: project.id, title: "Base", objective: "Build base", scopeIn: ["base"], acceptanceCriteria: ["base works"], verificationCommands: ["npm test"] }, "codex") as any;
    const second = store.createTask({ projectId: project.id, title: "Feature", objective: "Build feature", scopeIn: ["feature"], acceptanceCriteria: ["feature works"], verificationCommands: ["npm test"], dependencies: [first.id] }, "codex") as any;
    assert.deepEqual((store.nextTasks(project.id) as any[]).map(t => t.id), [first.id]);
    store.claimTask(first.id, "antigravity");
    store.submitTask(first.id, { summary: "done", changedFiles: ["base/a.ts"], tests: [{ command: "npm test", result: "passed" }], acceptanceResults: [{ criterion: "base works", result: "passed", evidence: "test" }] }, "antigravity");
    store.reviewTask(first.id, "approve", [], [], "codex");
    assert.deepEqual((store.nextTasks(project.id) as any[]).map(t => t.id), [second.id]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("submission rejects files outside scope", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const task = store.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn: ["src/**"], scopeOut: ["src/secrets"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    store.claimTask(task.id, "antigravity");
    const submission = { summary: "done", changedFiles: ["README.md"], tests: [{ command: "test", result: "passed" as const }], acceptanceResults: [{ criterion: "A", result: "passed" as const, evidence: "ok" }] };
    assert.throws(() => store.submitTask(task.id, submission, "antigravity"), /outside scopeIn/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("submission requires evidence for every criterion", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    assert.equal((store.listProjects() as any[])[0].id, project.id);
    const task = store.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn: ["x"], acceptanceCriteria: ["A", "B"], verificationCommands: ["test"] }, "codex") as any;
    store.claimTask(task.id, "antigravity");
    assert.throws(() => store.submitTask(task.id, { summary: "done", changedFiles: ["x"], tests: [{ command: "test", result: "passed" }], acceptanceResults: [{ criterion: "A", result: "passed", evidence: "ok" }] }, "antigravity"), /Missing acceptance evidence/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claimed task reports progress in task and project status", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const task = store.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn: ["x"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    store.claimTask(task.id, "antigravity");
    const updated = store.updateTaskProgress(task.id, 40, "Implementation in progress", "antigravity") as any;
    assert.equal(updated.progressPercent, 40);
    assert.equal(updated.progressNote, "Implementation in progress");
    assert.equal((store.status(project.id) as any).active[0].progressPercent, 40);
    assert.throws(() => store.updateTaskProgress(task.id, 30, "Backwards", "antigravity"), /cannot decrease/);
    assert.throws(() => store.submitTask(task.id, { summary: "wrong worker", changedFiles: ["x"], tests: [{ command: "test", result: "passed" }], acceptanceResults: [{ criterion: "A", result: "passed", evidence: "ok" }] }, "other"), /claimed by antigravity/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent sessions expose heartbeat and stale status", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const session = store.startSession("antigravity", "worker", "worker-1") as any;
    store.heartbeatSession(session.id, { status: "busy", taskId: "tsk_demo" });
    const active = store.listSessions(undefined, false, 120) as any[];
    assert.equal(active[0].effectiveStatus, "busy");
    assert.equal(active[0].taskId, "tsk_demo");
    store.endSession(session.id);
    assert.equal((store.listSessions(undefined, true) as any[])[0].status, "ended");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manager recovery protects live workers and requeues abandoned claims", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const task = store.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn: ["x"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    store.claimTask(task.id, "antigravity");
    const session = store.startSession("antigravity", "worker", "antigravity") as any;
    store.heartbeatSession(session.id, { projectId: project.id, taskId: task.id, status: "busy" });
    assert.throws(() => store.requeueTask(task.id, "restart", "codex"), /live worker/);
    store.endSession(session.id);
    const recovered = store.recoverProject(project.id, 180, "codex") as any;
    assert.deepEqual(recovered.recovered, [task.id]);
    assert.equal((store.getTask(task.id) as any).status, "ready");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task spec rejects cross-project and cyclic dependencies", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const firstProject = store.createProject({ name: "One", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const secondProject = store.createProject({ name: "Two", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const first = store.createTask({ projectId: firstProject.id, title: "First", objective: "O", scopeIn: ["x"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    const second = store.createTask({ projectId: firstProject.id, title: "Second", objective: "O", scopeIn: ["x"], acceptanceCriteria: ["A"], verificationCommands: ["test"], dependencies: [first.id] }, "codex") as any;
    const foreign = store.createTask({ projectId: secondProject.id, title: "Foreign", objective: "O", scopeIn: ["x"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    assert.throws(() => store.updateTaskSpec(second.id, { dependencies: [foreign.id] }, "codex"), /Invalid dependency/);
    assert.throws(() => store.updateTaskSpec(first.id, { dependencies: [second.id] }, "codex"), /Dependency cycle/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked task releases its worker claim and heartbeat", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const task = store.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn: ["x"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    store.claimTask(task.id, "antigravity");
    const blocked = store.blockTask(task.id, "Missing input", ["Input"], "antigravity") as any;
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.claimedBy, null);
    assert.equal(blocked.heartbeatAt, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task assignment is enforced when listing and claiming work", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const task = store.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn: ["src"], acceptanceCriteria: ["A"], verificationCommands: ["test"], assignee: "worker-a" }, "codex") as any;
    assert.deepEqual(store.nextTasks(project.id, 5, "worker-b"), []);
    assert.throws(() => store.claimTask(task.id, "worker-b"), /assigned to worker-a/);
    assert.equal((store.claimTask(task.id, "worker-a") as any).claimedBy, "worker-a");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope validation rejects traversal and Windows path bypasses", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const create = (scopeIn: string[]) => store.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn, acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex");
    assert.throws(() => create(["../src"]), /safe repository-relative path/);
    assert.throws(() => create(["C:/src"]), /safe repository-relative path/);
    assert.throws(() => create(["src/file:stream"]), /safe repository-relative path/);
    const task = store.createTask({ projectId: project.id, title: "Case", objective: "O", scopeIn: ["SRC/**"], scopeOut: ["src/secret"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    store.claimTask(task.id, "antigravity");
    const submission = (file: string) => ({ summary: "done", changedFiles: [file], tests: [{ command: "test", result: "passed" as const }], acceptanceResults: [{ criterion: "A", result: "passed" as const, evidence: "ok" }] });
    assert.throws(() => store.submitTask(task.id, submission("../src/a.ts"), "antigravity"), /safe repository-relative path/);
    if (process.platform === "win32") assert.throws(() => store.submitTask(task.id, submission("Src/Secret/a.ts"), "antigravity"), /out of scope/);
    assert.equal((store.submitTask(task.id, submission("src/App.ts"), "antigravity") as any).status, "submitted");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval requires passed verification and acceptance evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    const create = (title: string) => store.createTask({ projectId: project.id, title, objective: "O", scopeIn: ["src"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    const failedTest = create("Failed test");
    store.claimTask(failedTest.id, "antigravity");
    store.submitTask(failedTest.id, { summary: "done", changedFiles: ["src/a.ts"], tests: [{ command: "test", result: "failed" }], acceptanceResults: [{ criterion: "A", result: "passed", evidence: "ok" }] }, "antigravity");
    assert.throws(() => store.reviewTask(failedTest.id, "approve", [], [], "codex"), /verification not passed/);
    const failedCriterion = create("Failed criterion");
    store.claimTask(failedCriterion.id, "antigravity");
    store.submitTask(failedCriterion.id, { summary: "done", changedFiles: ["src/b.ts"], tests: [{ command: "test", result: "passed" }], acceptanceResults: [{ criterion: "A", result: "failed", evidence: "not met" }] }, "antigravity");
    assert.throws(() => store.reviewTask(failedCriterion.id, "approve", [], [], "codex"), /acceptance criteria not passed/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project status exposes strict terminal and progress states", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-"));
  const store = new CoordinatorStore(join(dir, "test.db"));
  try {
    const project = store.createProject({ name: "Demo", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
    assert.equal((store.status(project.id) as any).state, "needs_attention");
    const task = store.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn: ["src"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex") as any;
    assert.equal((store.status(project.id) as any).state, "ready");
    store.claimTask(task.id, "antigravity");
    const session = store.startSession("antigravity", "worker", "antigravity") as any;
    store.heartbeatSession(session.id, { projectId: project.id, taskId: task.id, status: "busy" });
    assert.equal((store.status(project.id) as any).state, "running");
    store.submitTask(task.id, { summary: "done", changedFiles: ["src/a.ts"], tests: [{ command: "test", result: "passed" }], acceptanceResults: [{ criterion: "A", result: "passed", evidence: "ok" }] }, "antigravity");
    assert.equal((store.status(project.id) as any).state, "reviewing");
    store.reviewTask(task.id, "approve", [], [], "codex");
    const complete = store.status(project.id) as any;
    assert.equal(complete.state, "completed");
    assert.equal(complete.done, true);
    assert.equal(complete.approvedPercent, 100);
    store.recordProjectEvent(project.id, "runner", "runner_failed", { error: "late shutdown error" });
    assert.equal((store.status(project.id) as any).state, "completed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
