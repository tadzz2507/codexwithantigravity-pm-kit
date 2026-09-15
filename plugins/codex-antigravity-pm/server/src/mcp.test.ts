import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CoordinatorStore } from "./store.js";

const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

async function toolNames(role: "manager" | "worker", dbPath: string): Promise<string[]> {
  const client = new Client({ name: `test-${role}`, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...cleanEnv, PM_ROLE: role, PM_ACTOR: role, PM_DB_PATH: dbPath }
  });
  await client.connect(transport);
  try { return (await client.listTools()).tools.map(tool => tool.name); }
  finally { await client.close(); }
}

test("MCP exposes role-specific tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-tools-"));
  try {
    const dbPath = join(dir, "test.db");
    const manager = await toolNames("manager", dbPath);
    const worker = await toolNames("worker", dbPath);
    assert(manager.includes("project_init"));
    assert(manager.includes("project_run"));
    assert(manager.includes("project_list"));
    assert(manager.includes("project_wait"));
    assert(manager.includes("health_check"));
    assert(manager.includes("session_list"));
    assert(manager.includes("project_worker_start"));
    assert(manager.includes("project_worker_status"));
    assert(manager.includes("project_worker_stop"));
    assert(manager.includes("task_review"));
    assert(manager.includes("task_requeue"));
    assert(manager.includes("project_recover"));
    assert(!manager.includes("task_submit"));
    assert(worker.includes("task_claim"));
    assert(worker.includes("task_submit"));
    assert(worker.includes("task_progress"));
    assert(worker.includes("project_wait"));
    assert(!worker.includes("project_init"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project_wait returns when a new ledger event arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-wait-"));
  const dbPath = join(dir, "test.db");
  const setupStore = new CoordinatorStore(dbPath);
  const project = setupStore.createProject({ name: "Wait", outcome: "Ship", definitionOfDone: ["Done"] }, "codex") as any;
  setupStore.createTask({ projectId: project.id, title: "Initial", objective: "O", scopeIn: ["src"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex");
  const afterEventId = ((setupStore.events(project.id, 1) as any[])[0]).id;
  setupStore.close();
  const client = new Client({ name: "wait-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...cleanEnv, PM_ROLE: "manager", PM_ACTOR: "codex", PM_DB_PATH: dbPath }
  });
  try {
    await client.connect(transport);
    const timer = setTimeout(() => {
      const eventStore = new CoordinatorStore(dbPath);
      try {
        eventStore.createTask({ projectId: project.id, title: "T", objective: "O", scopeIn: ["src"], acceptanceCriteria: ["A"], verificationCommands: ["test"] }, "codex");
      } finally { eventStore.close(); }
    }, 100);
    const result = await client.callTool({ name: "project_wait", arguments: { projectId: project.id, afterEventId, waitSeconds: 2 } }) as any;
    clearTimeout(timer);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.reason, "event");
    assert(payload.status.lastEvent.id > afterEventId);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP client disconnect ends its session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-mcp-disconnect-"));
  const dbPath = join(dir, "test.db");
  const client = new Client({ name: "disconnect-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...cleanEnv, PM_ROLE: "manager", PM_ACTOR: "test", PM_DB_PATH: dbPath }
  });
  try {
    await client.connect(transport);
    await client.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    const store = new CoordinatorStore(dbPath);
    try {
      const sessions = store.listSessions(undefined, true) as Array<Record<string, unknown>>;
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].status, "ended");
    } finally { store.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
