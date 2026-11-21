import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import registerEditLast from "../src/edit-last.ts";
import { assistant } from "./fixtures.ts";

function harness() {
  const sm = SessionManager.inMemory();
  let command: Parameters<ExtensionAPI["registerCommand"]>[1];
  let shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1];
  const state = { editor: "", idle: true, pending: false, cancelled: false, commandName: "pi-bar-edit-last" };
  const notices: string[] = [];
  const targets: string[] = [];
  const ctx = {
    mode: "tui",
    ui: { getEditorText: () => state.editor, notify: (s: string) => notices.push(s) },
    sessionManager: sm,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    navigateTree: async (id: string, options: unknown) => {
      assert.deepEqual(options, { summarize: false });
      assert.notEqual(id, sm.getLeafId(), "Pi ignores navigation to the current leaf");
      targets.push(id);
      return { cancelled: state.cancelled };
    },
  } as unknown as ExtensionCommandContext;
  let dispatched: Promise<void> | undefined;
  const pi: Partial<ExtensionAPI> = {
    registerCommand(name, options) {
      assert.equal(name, state.commandName);
      command = options;
    },
    registerShortcut(key, options) {
      assert.equal(key, "f2");
      shortcut = options;
    },
    getCommands: () => [
      {
        name: state.commandName,
        source: "extension",
        sourceInfo: { path: "edit-last.ts", source: "local", scope: "project", origin: "package" },
      },
    ],
    sendUserMessage(text, options) {
      assert.equal(text, "/pi-bar-edit-last");
      assert.deepEqual(options, { expandPromptTemplates: true });
      dispatched = command.handler("", ctx);
    },
    appendEntry: (type, data) => sm.appendCustomEntry(type, data),
  };
  registerEditLast(pi as ExtensionAPI);
  return {
    sm,
    state,
    notices,
    targets,
    async press() {
      await shortcut.handler(ctx);
      await dispatched;
    },
    ask: (content: string) => sm.appendMessage({ role: "user", content, timestamp: 0 }),
  };
}

test("F2 targets the latest user entry on this branch, not its parent or a newer sibling", async () => {
  const h = harness();
  const root = h.ask("context");
  const prompt = h.ask("分析 A 和 B\n\n  - 保留缩进");
  const answer = h.sm.appendMessage(assistant({ stopReason: "aborted" }));
  const leaf = h.sm.appendCustomEntry("stats");
  h.sm.branch(root);
  h.ask("newer sibling");
  h.sm.branch(leaf);
  await h.press();
  assert.deepEqual(h.targets, [prompt]);
  assert.ok(h.sm.getEntry(answer));
  assert.equal(h.sm.getEntries().length, 5);
});

test("interruption before the first reply can recall even a root prompt", async () => {
  const h = harness();
  const id = h.ask("first");
  await h.press();
  assert.deepEqual(h.targets, [id]);
  assert.equal(h.sm.buildSessionContext().messages.length, 1); // The anchor isn't a model message.
});

test("draft (including whitespace), busy, queued, or no prompt: notify without changing the branch", async () => {
  const h = harness();
  await h.press();
  const id = h.ask("first");
  for (const draft of ["not sent", " \n"]) {
    h.state.editor = draft;
    await h.press();
    assert.equal(h.state.editor, draft);
  }
  h.state.editor = "";
  h.state.idle = false;
  await h.press();
  h.state.idle = true;
  h.state.pending = true;
  await h.press();
  assert.equal(h.notices.length, 5);
  assert.deepEqual(h.targets, []);
  assert.equal(h.sm.getLeafId(), id);
});

test("do not silently drop attachments or substitute an older text prompt", async () => {
  const h = harness();
  h.ask("older");
  const id = h.sm.appendMessage({
    role: "user",
    content: [{ type: "image", mimeType: "image/png", data: "" }],
    timestamp: 0,
  });
  await h.press();
  assert.deepEqual(h.targets, []);
  assert.equal(h.sm.getLeafId(), id);
  assert.equal(h.notices.length, 1);
});

test("command collision and cancelled navigation do not submit any prompt", async () => {
  const h = harness();
  const id = h.ask("question");
  const leaf = h.sm.appendMessage(assistant());
  h.state.commandName += ":1";
  await h.press();
  assert.deepEqual(h.targets, []);
  h.state.commandName = "pi-bar-edit-last";
  h.state.cancelled = true;
  await h.press();
  assert.deepEqual(h.targets, [id]);
  assert.equal(h.sm.getLeafId(), leaf);
  assert.equal(h.state.editor, "");
  assert.equal(h.notices.length, 2);
});
