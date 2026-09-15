import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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
    assert(!worker.includes("project_init"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
