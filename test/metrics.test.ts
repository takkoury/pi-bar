import assert from "node:assert/strict";
import test from "node:test";
import { sessionUsage, TaskTracker, TASK_ENTRY } from "../src/metrics.ts";
import { assistant, entry, usage } from "./fixtures.ts";

test("session totals count all persisted usage exactly once, latest prompt defines cache rate", () => {
  const entries = [
    entry({ type: "message", message: assistant() }),
    entry({ type: "compaction", usage: usage() }),
    entry({ type: "branch_summary", usage: usage() }),
    entry({ type: "usage", kind: "unknown-future-kind", usage: usage() }),
    entry({
      type: "message",
      message: { role: "toolResult", usage: usage(), nestedCalls: { calls: [{ usage: usage() }] } },
    }),
    entry({
      type: "message",
      message: assistant({ usage: usage({ input: 100, cacheRead: 700, cacheWrite: 200, reasoning: 80 }) }),
    }),
    entry({ type: "custom", customType: "other", data: { usage: usage() } }),
  ];
  const result = sessionUsage(entries);
  assert.equal(result.input, 1100); // Ordinary input excludes separately counted cache traffic.
  assert.equal(result.output, 600); // Reasoning is already in output.
  assert.equal(result.cache, 70);
  assert.ok(Math.abs(result.cost - 0.24) < 1e-12);
});

test("empty or zero-usage requests do not invent cache statistics", () => {
  assert.equal(sessionUsage([]).cache, null);
  assert.equal(
    sessionUsage([entry({ type: "message", message: assistant({ usage: usage({ input: 0, cacheRead: 0 }) }) })]).cache,
    null,
  );
  assert.equal(
    sessionUsage([entry({ type: "message", message: assistant({ usage: usage({ cacheRead: 0 }) }) })]).cache,
    0,
  );
});

test("task time includes tools; weighted request throughput excludes tools and idle time", () => {
  let now = 0;
  const tracker = new TaskTracker(() => now);
  tracker.start();
  tracker.requestStart();
  now = 2000;
  tracker.response(assistant({ durationMs: 2000, usage: usage({ output: 100 }) }));
  assert.equal(tracker.snapshot().speed, 50);
  now = 12000; // ten seconds of tool work
  tracker.start(); // Retry / continuation must not reset the task.
  tracker.requestStart();
  assert.equal(tracker.snapshot().speed, 50); // Previous measured response, never a fabricated live rate.
  now = 16000;
  tracker.response(assistant({ durationMs: 4000, usage: usage({ output: 400 }) }));
  assert.equal(tracker.snapshot().speed, 100);
  const final = tracker.settle(false);
  assert.equal(final.elapsedMs, 16000);
  assert.ok(Math.abs(final.speed! - 500 / 6) < 1e-12);
  now = 999999;
  assert.deepEqual(tracker.snapshot(), final);
  tracker.start();
  assert.equal(tracker.snapshot().speed, null);
  assert.equal(tracker.snapshot().elapsedMs, 0);
});

test("error recovery, abort, and unreported timings remain honest", () => {
  let now = 0;
  const tracker = new TaskTracker(() => now);
  tracker.start();
  tracker.requestStart();
  now = 1000;
  tracker.response(assistant({ stopReason: "error", durationMs: 1000 }));
  tracker.start();
  tracker.requestStart();
  now = 3000;
  tracker.response(assistant({ stopReason: "stop" })); // Fallback to monotonic request clock.
  assert.equal(tracker.settle(false).state, "done");
  tracker.start();
  now = 4000;
  tracker.response(assistant({ stopReason: "error" }));
  assert.deepEqual(tracker.settle(false), { state: "error", elapsedMs: 1000, speed: null });
  tracker.start();
  now = 6000;
  assert.deepEqual(tracker.settle(true), { state: "aborted", elapsedMs: 2000, speed: null });
  tracker.start();
  tracker.response(assistant()); // No request start/timing: no invented throughput.
  assert.equal(tracker.settle(false).speed, null);
});

test("final task metrics restore on the active branch only and reject corrupt state", () => {
  const tracker = new TaskTracker();
  const saved = entry({ type: "custom", customType: TASK_ENTRY, data: { state: "done", elapsedMs: 48000, speed: 56 } });
  tracker.restore([entry({ type: "message", message: assistant() }), saved]);
  assert.deepEqual(tracker.snapshot(), { state: "done", elapsedMs: 48000, speed: 56 });
  tracker.restore([saved, entry({ type: "message", message: { role: "user" } })]);
  assert.equal(tracker.snapshot().state, "idle");
  tracker.restore([entry({ type: "custom", customType: TASK_ENTRY, data: { state: "done", elapsedMs: NaN } })]);
  assert.equal(tracker.snapshot().state, "idle");
});

test("invalid usage values never contaminate session totals", () => {
  const result = sessionUsage([
    entry({
      type: "message",
      message: assistant({
        usage: usage({
          input: NaN,
          output: -1,
          cacheRead: Infinity,
          cacheWrite: -5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Infinity },
        }),
      }),
    }),
  ]);
  assert.deepEqual(result, { input: 0, output: 0, cost: 0, cache: null });
});

test("restoration rejects malformed records without falling back to older task measurements", () => {
  const tracker = new TaskTracker(() => 0);
  const saved = entry({ type: "custom", customType: TASK_ENTRY, data: { state: "done", elapsedMs: 10, speed: 50 } });
  for (const data of [
    null,
    "done",
    42,
    [],
    {},
    { state: "working", elapsedMs: 10 },
    { state: "done", elapsedMs: -1 },
    { state: "done", elapsedMs: Infinity },
    { state: "done", elapsedMs: "10" },
  ]) {
    tracker.start();
    assert.equal(tracker.isWorking, true);
    tracker.restore([saved, entry({ type: "custom", customType: TASK_ENTRY, data })]);
    assert.equal(tracker.isWorking, false);
    assert.deepEqual(tracker.snapshot(), { state: "idle", elapsedMs: null, speed: null });
  }
  for (const speed of [NaN, Infinity, -1, 0, "50", undefined]) {
    tracker.restore([entry({ type: "custom", customType: TASK_ENTRY, data: { state: "done", elapsedMs: 10, speed } })]);
    assert.deepEqual(tracker.snapshot(), { state: "done", elapsedMs: 10, speed: null });
  }
});

test("deferred responses and invalid timings do not invent throughput", () => {
  for (const durationMs of [0, -1, NaN, Infinity]) {
    const tracker = new TaskTracker(() => 0);
    tracker.requestStart();
    tracker.response(assistant({ durationMs }));
    assert.equal(tracker.snapshot().speed, null);
    assert.equal(tracker.settle(false).speed, null);
  }
  const tracker = new TaskTracker(() => 0);
  tracker.requestStart();
  tracker.response(assistant({ durationMs: 1000, stopReason: "deferred" }));
  assert.equal(tracker.settle(false).speed, null);
});
