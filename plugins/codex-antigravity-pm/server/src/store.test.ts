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
