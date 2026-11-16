import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runGit } from "../src/git-process.ts";

// Git shell aliases let these tests exercise process trees without a network connection.
test("timeout terminates a Git subprocess tree without waiting for its child", { timeout: 5000 }, async () => {
  const started = Date.now();
  const result = await runGit(
    tmpdir(),
    ["-c", "alias.pi-bar-wait=!sleep 30", "pi-bar-wait"],
    new AbortController().signal,
    150,
  );
  assert.equal(result.killed, true);
  assert.ok(Date.now() - started < 4000);
});

test("process wrapper handles a missing cwd and pre-aborted commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-bar-process-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runGit(root, ["status"], controller.signal)).killed, true);
  assert.notEqual((await runGit(join(root, "missing"), ["status"], new AbortController().signal)).code, 0);
});

test("process output is bounded even when a command exceeds the buffer limit", { timeout: 5000 }, async () => {
  const result = await runGit(
    tmpdir(),
    ["-c", "alias.pi-bar-output=!printf '%3145728s' x", "pi-bar-output"],
    new AbortController().signal,
  );
  assert.equal(result.killed, true);
  assert.equal(result.code, -1);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 2 * 1024 * 1024);
});
