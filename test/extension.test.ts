import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statusline from "../src/index.ts";
import { assistant, entry } from "./fixtures.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

function harness(t: TestContext, mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "pi-bar-extension-"));
  let command: Command | undefined;
  let footer: ReturnType<FooterFactory> | undefined;
  let renders = 0;
  let subscriptions = 0;
  let statsReads = 0;
  const entries = [entry({ type: "message", message: assistant() })];
  let contextTokens: number | null = 182000;
  let sessionId = "test";
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(_name: string, options: { handler: Command }) {
      command = options.handler;
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
            getExtensionStatuses: () => new Map([["test", "external status"]]),
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
    await handlers.get(name)?.(event, ctx);
  };
  t.after(async () => {
    await emit("session_shutdown");
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  statusline(pi);
  return {
    ctx,
    entries,
    notifications,
    emit,
    run: async (args: string) => {
      await command?.(args, ctx);
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
  await h.run("line");
  assert.equal(h.state().subscriptions, 1);
  assert.match(h.rows()![1], /━/);
  await h.run("statuses");
  assert.deepEqual(h.notifications, ["test: external status"]);
  await h.emit("session_shutdown");
  assert.equal(h.state().subscriptions, 0);
});

test("print, JSON and RPC modes never install footer, poll Git or persist task state", async (t) => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const h = harness(t, mode);
    await h.emit("session_start");
    await h.emit("before_agent_start");
    await h.emit("turn_start");
    await h.emit("message_end", { message: assistant() });
    await h.emit("agent_settled", { aborted: false });
    await h.run("on");
    assert.equal(h.state().footer, undefined);
    assert.equal(h.entries.length, 1);
  }
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
  await h.run("on");
  assert.equal(h.state().footer, original);
  await h.run("off");
  await h.run("on");
  assert.notEqual(h.state().footer, original);
  original.dispose?.();
  assert.equal(h.state().subscriptions, 1);
  await h.emit("before_agent_start");
  assert.match(h.rows()![1], /● working/);
  await h.run("");
  assert.equal(h.state().footer, undefined);
  await h.run("");
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
