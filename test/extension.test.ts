import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piBar from "../src/index.ts";
import { assistant, entry } from "./fixtures.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type TerminalInputHandler = Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0];

const ENABLE_FOCUS = "\x1b[?1004h";
const DISABLE_FOCUS = "\x1b[?1004l";
const BELL = "\x07";

function harness(t: TestContext, mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  const terminalWrites: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (...args: Parameters<typeof write>) => {
    if (args[0] === ENABLE_FOCUS || args[0] === DISABLE_FOCUS || args[0] === BELL) {
      terminalWrites.push(args[0]);
      return true;
    }
    return write(...args);
  });
  const terminalHandlers = new Set<TerminalInputHandler>();
  const cwd = mkdtempSync(join(tmpdir(), "pi-bar-extension-"));
  const commands = new Map<string, Command>();
  let footer: ReturnType<FooterFactory> | undefined;
  let renders = 0;
  let subscriptions = 0;
  let statsReads = 0;
  const entries = [entry({ type: "message", message: assistant() })];
  let contextTokens: number | null = 182000;
  let sessionId = "test";
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: Command }) {
      assert.ok(!commands.has(name));
      commands.set(name, options.handler);
    },
    getThinkingLevel: () => "high",
    appendEntry(customType: string, data: unknown) {
      entries.push(entry({ type: "custom", customType, data }));
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd,
    model: { provider: "openai", id: "gpt-test", contextWindow: 500000 },
    thinkingLevel: "high",
    getContextUsage: () => ({
      tokens: contextTokens,
      contextWindow: 500000,
      percent: contextTokens === null ? null : contextTokens / 5000,
    }),
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => {
        statsReads++;
        return entries;
      },
      getLeafId: () => entries.at(-1)?.id ?? null,
      getSessionId: () => sessionId,
    },
    ui: {
      theme: { appearance: "dark", style: (text: string) => text },
      notify(message: string) {
        notifications.push(message);
      },
      onTerminalInput(handler: TerminalInputHandler) {
        terminalHandlers.add(handler);
        return () => terminalHandlers.delete(handler);
      },
      setFooter(factory: FooterFactory | undefined) {
        footer?.dispose?.();
        footer = factory?.(
          {
            requestRender() {
              renders++;
            },
          } as Parameters<FooterFactory>[0],
          ctx.ui.theme,
          {
            getGitBranch: () => null,
            getAvailableProviderCount: () => 1,
            getExtensionStatuses: () => new Map(),
            onBranchChange: () => {
              subscriptions++;
              return () => {
                subscriptions--;
              };
            },
          },
        );
      },
    },
  } as unknown as ExtensionCommandContext;
  const emit = async (name: string, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  t.after(async () => {
    await emit("session_shutdown");
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  piBar(pi);
  return {
    commands,
    ctx,
    entries,
    notifications,
    terminalWrites,
    terminalHandlers,
    bells: () => terminalWrites.filter((data) => data === BELL).length,
    emit,
    run: async (args: string, name = "footer") => {
      const command = commands.get(name);
      assert.ok(command, `/${name} must be registered`);
      await command(args, ctx);
    },
    rows: () => footer?.render(160).map(stripVTControlCharacters),
    state: () => ({ renders, subscriptions, statsReads, footer }),
    setTokens: (tokens: number | null) => {
      contextTokens = tokens;
    },
    setSession: (id: string) => {
      sessionId = id;
    },
  };
}

test("extension lifecycle: continuation, final result, abort/error, model/thinking and compaction", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  assert.equal(h.state().subscriptions, 1);
  assert.match(h.rows()![1], /○ idle/);
  await h.emit("before_agent_start");
  await h.emit("agent_start");
  await h.emit("turn_start");
  assert.match(h.rows()![1], /● working/);
  const response = assistant({ durationMs: 2000 });
  await h.emit("message_end", { message: response });
  h.entries.push(entry({ type: "message", message: response }));
  await h.emit("agent_end");
  assert.match(h.rows()![1], /● working/); // Low-level end must not finalize.
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  assert.match(h.rows()![1], /✓ done/);
  assert.match(h.rows()![1], /50tk\/s/);
  assert.doesNotMatch(h.rows()![1], /avg/);
  assert.equal(h.entries.at(-1)?.type, "custom");

  await h.emit("before_agent_start");
  await h.emit("agent_settled", { aborted: true });
  assert.match(h.rows()![1], /■ aborted/);
  assert.doesNotMatch(h.rows()![1], /tk\/s/);
  await h.emit("before_agent_start");
  await h.emit("message_end", { message: assistant({ stopReason: "error" }) });
  await h.emit("agent_settled", { aborted: false });
  assert.match(h.rows()![1], /× error/);

  h.setTokens(null);
  await h.emit("session_compact");
  assert.match(h.rows()![1], /\?▰+ 500k \?%/);
  h.setTokens(20000);
  await h.emit("model_select");
  assert.match(h.rows()![1], /20k▰+ 500k 4%/);
  h.ctx.thinkingLevel = "low";
  await h.emit("thinking_level_select");
  assert.match(h.rows()![0], /\[openai\] gpt-test \[low\]/);
  await h.run("off");
  assert.equal(h.state().subscriptions, 0);
  await h.run("on");
  assert.equal(h.state().subscriptions, 1);
  assert.match(h.rows()![1], /20k▰{8} 500k 4%/);
  assert.deepEqual(h.notifications, []);
  await h.emit("session_shutdown");
  assert.equal(h.state().subscriptions, 0);
});

test("only /footer and /notify are registered; unknown footer arguments do not change its state", async (t) => {
  const h = harness(t);
  assert.deepEqual([...h.commands.keys()].sort(), ["footer", "notify"]);
  await h.emit("session_start");
  for (const enabled of [true, false]) {
    if (!enabled) await h.run("off");
    const original = h.state().footer;
    for (const action of ["cells", "line", "refresh", "statuses", "unknown", "on off"]) {
      await h.run(action);
      assert.equal(h.notifications.pop(), "/footer [on|off]");
      assert.equal(h.state().footer, original);
      assert.equal(h.state().subscriptions, enabled ? 1 : 0);
    }
  }
});

test("print, JSON and RPC modes never install footer, watch focus, poll Git or persist task state", async (t) => {
  const stdinListeners = process.stdin.listenerCount("data");
  for (const mode of ["print", "json", "rpc"] as const) {
    await t.test(mode, async (subtest) => {
      const h = harness(subtest, mode);
      await h.emit("session_start");
      await h.emit("before_agent_start");
      await h.emit("agent_start");
      await h.emit("turn_start");
      await h.emit("message_end", { message: assistant() });
      await h.emit("agent_settled", { aborted: false });
      await h.run("on");
      await h.run("on", "notify");
      assert.equal(h.state().footer, undefined);
      assert.equal(h.entries.length, 1);
      assert.equal(h.terminalHandlers.size, 0);
      assert.deepEqual(h.terminalWrites, []);
      assert.equal(process.stdin.listenerCount("data"), stdinListeners);
    });
  }
});

test("rings once for background task completion, only at final settlement", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  await h.emit("agent_start");
  // Pi's input pipeline may receive a split focus report, or swallow it in fullscreen.
  process.stdin.emit("data", Buffer.from("\x1b["));
  process.stdin.emit("data", Buffer.from("O"));
  await h.emit("agent_end");
  await h.emit("agent_start"); // Retry or queued continuation.
  assert.equal(h.bells(), 0);
  await h.emit("agent_settled", { aborted: false });
  await h.emit("agent_settled", { aborted: false });
  await h.emit("session_tree");
  assert.equal(h.bells(), 1);

  await h.emit("agent_start");
  await h.emit("message_end", { message: assistant({ stopReason: "error" }) });
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.bells(), 2);

  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: true });
  await h.emit("agent_start");
  await h.emit("message_end", { message: assistant({ stopReason: "aborted" }) });
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.bells(), 2);
});

test("unknown or restored focus is silent, and bracketed paste does not change focus", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  await h.emit("agent_start");
  process.stdin.emit("data", "\x1b[O\x1b[I");
  process.stdin.emit("data", "\x1b[200~\x1b[O\x1b[201~");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.bells(), 0);
});

test("/notify toggles only reminders and ignores invalid arguments", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  const footer = h.state().footer;
  process.stdin.emit("data", "\x1b[O");

  for (const [args, expected] of [
    ["invalid", 1],
    [" off ", 1],
    ["off", 1],
    ["invalid", 1],
    ["", 2],
    [" ", 2],
    ["on", 3],
    ["on", 4],
  ] as const) {
    await h.run(args, "notify");
    if (args === "invalid") assert.equal(h.notifications.at(-1), "/notify [on|off]");
    await h.emit("agent_start");
    await h.emit("agent_settled", { aborted: false });
    assert.equal(h.bells(), expected, `unexpected bell count for /notify ${args}`);
    assert.equal(h.state().footer, footer);
    assert.equal(h.state().subscriptions, 1);
  }
});

test("notify stays active with the footer disabled or replaced, and cleans up at shutdown", async (t) => {
  const h = harness(t);
  const stdinListeners = process.stdin.listenerCount("data");
  await h.emit("session_start");
  assert.deepEqual(h.terminalWrites, [ENABLE_FOCUS]);
  assert.equal(process.stdin.listenerCount("data"), stdinListeners + 1);
  const [handle] = h.terminalHandlers;
  assert.equal(handle("a"), undefined);
  assert.deepEqual(handle("\x1b[O"), { consume: true });

  process.stdin.emit("data", "\x1b[O");
  await h.run("off");
  assert.equal(h.state().footer, undefined);
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.bells(), 1);

  await h.run("on");
  h.state().footer?.dispose?.(); // Another extension replaces the footer.
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.bells(), 2);
  assert.equal(h.terminalHandlers.size, 1);
  assert.equal(process.stdin.listenerCount("data"), stdinListeners + 1);

  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.deepEqual(h.terminalWrites, [ENABLE_FOCUS, ENABLE_FOCUS, BELL, ENABLE_FOCUS, BELL, DISABLE_FOCUS]);
  assert.equal(h.terminalHandlers.size, 0);
  assert.equal(process.stdin.listenerCount("data"), stdinListeners);

  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.bells(), 2); // A new session has not received a focus report yet.
});

test("replacement footer disposal is idempotent and shutdown does not restore over its replacement", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  const component = h.state().footer!;
  component.dispose?.();
  component.dispose?.();
  assert.equal(h.state().subscriptions, 0);
  const before = h.state().renders;
  await h.emit("agent_start");
  await h.emit("session_shutdown");
  assert.equal(h.state().renders, before);
  assert.deepEqual(component.render(160), ["", ""]);
});

test("on is idempotent; old footer disposal cannot detach a new installation", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  const original = h.state().footer!;
  await h.run(" on ");
  assert.equal(h.state().footer, original);
  await h.run(" off ");
  await h.run("off");
  assert.equal(h.state().footer, undefined);
  assert.equal(h.state().subscriptions, 0);
  await h.run("on");
  assert.notEqual(h.state().footer, original);
  original.dispose?.();
  assert.equal(h.state().subscriptions, 1);
  await h.emit("before_agent_start");
  assert.match(h.rows()![1], /● working/);
  await h.run("");
  assert.equal(h.state().footer, undefined);
  await h.run("  ");
  assert.equal(h.state().subscriptions, 1);
});

test("statistics cache avoids rescanning history until its inputs change", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  h.rows();
  h.rows();
  assert.equal(h.state().statsReads, 1);

  h.entries.push(entry({ type: "message", message: assistant() }));
  assert.match(h.rows()![1], /↑400 ↓200/);
  assert.equal(h.state().statsReads, 2);

  h.setTokens(20000);
  h.state().footer!.invalidate();
  assert.match(h.rows()![1], /20k▰+ 500k 4%/);
  assert.equal(h.state().statsReads, 3);

  h.setTokens(30000);
  h.setSession("replacement");
  assert.match(h.rows()![1], /30k▰+ 500k 6%/);
  assert.equal(h.state().statsReads, 4);

  h.setTokens(40000);
  h.ctx.model = { ...h.ctx.model!, id: "replacement-model" };
  assert.match(h.rows()![1], /40k▰+ 500k 8%/);
  assert.equal(h.state().statsReads, 5);
});

test("model label follows provider changes and handles no selected model", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  assert.match(h.rows()![0], /\[openai\] gpt-test \[high\]/);

  h.ctx.model = { ...h.ctx.model!, provider: "custom" };
  await h.emit("model_select");
  assert.match(h.rows()![0], /\[custom\] gpt-test \[high\]/);

  h.ctx.model = undefined;
  await h.emit("model_select");
  assert.match(h.rows()![0], /no model \[high\]/);
  assert.doesNotMatch(h.rows()![0], /\[custom\]|undefined/);
});

test("tree navigation restores task state and duplicate settlement does not persist twice", async (t) => {
  const h = harness(t);
  await h.emit("session_start");
  await h.emit("before_agent_start");
  await h.emit("message_end", { message: assistant({ durationMs: 2000 }) });
  await h.emit("agent_settled", { aborted: false });
  const count = h.entries.length;
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.entries.length, count);
  await h.emit("session_tree");
  assert.match(h.rows()![1], /✓ done/);
  h.entries.pop();
  await h.emit("session_tree");
  assert.match(h.rows()![1], /○ idle/);
});
