import assert from "node:assert/strict";
import test from "node:test";
import { maxAttempts, retryDelaySeconds, shouldRetry, turnTimeoutMinutes } from "./worker-policy.js";

test("worker retry policy is bounded by default", () => {
  assert.equal(maxAttempts("bad"), 1);
  assert.equal(shouldRetry(1, maxAttempts("bad")), false);
  assert.equal(shouldRetry(1, 3), true);
  assert.equal(shouldRetry(3, 3), false);
});

test("retry backoff is exponential and capped", () => {
  assert.deepEqual([1, 2, 4], [1, 2, 3].map(attempt => retryDelaySeconds(attempt, 1)));
  assert.equal(retryDelaySeconds(20, 20), 300);
});

test("review runner keeps MCP mutations approvable", () => {
  const args = ["exec", "--ephemeral", "--approve-for-me", "-s", "workspace-write"];
  assert(args.includes("--approve-for-me"));
  assert(!args.includes('approval_policy="never"'));
});

test("Antigravity turn timeout supports long implementation runs", () => {
  assert.equal(turnTimeoutMinutes(), 120);
  assert.equal(turnTimeoutMinutes("240"), 240);
  assert.equal(turnTimeoutMinutes("9"), 120);
  assert.equal(turnTimeoutMinutes("481"), 120);
});
