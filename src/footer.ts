import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { GitMonitor } from "./git.ts";
import { sessionUsage, TASK_ENTRY, TaskTracker } from "./metrics.ts";
import { renderFooter, type FooterData } from "./render.ts";

interface ActiveFooter extends Pick<Component, "invalidate" | "render"> {
  refreshGit(force?: boolean): void;
  requestRender(): void;
  syncClock(): void;
  dispose(): void;
}

interface StatsCache {
  leafId: string | null;
  sessionId: string;
  model: ExtensionContext["model"];
  data: Pick<FooterData, "usage" | "context">;
}

export function registerFooter(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let footer: ActiveFooter | undefined;
  let closing: Promise<void> = Promise.resolve();
  let enabled = true;
  let stats: StatsCache | undefined;
  const task = new TaskTracker();

  const changed = () => {
    footer?.requestRender();
  };
  const getStats = (context: ExtensionContext): StatsCache["data"] => {
    const leafId = context.sessionManager.getLeafId();
    const sessionId = context.sessionManager.getSessionId();
    if (!stats || leafId !== stats.leafId || context.model !== stats.model || sessionId !== stats.sessionId) {
      const usage = context.getContextUsage();
      stats = {
        leafId,
        sessionId,
        model: context.model,
        data: {
          usage: sessionUsage(context.sessionManager.getEntries()),
          context: {
            tokens: usage?.tokens ?? null,
            capacity: usage?.contextWindow ?? context.model?.contextWindow ?? 0,
          },
        },
      };
    }
    return stats.data;
  };

  const install = (context: ExtensionContext) => {
    ctx = context;
    context.ui.setFooter((tui, _theme, footerData) => {
      let disposed = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const requestRender = () => {
        if (!disposed) tui.requestRender();
      };
      const git = new GitMonitor(context.cwd, requestRender, {
        fetchEnabled: !/^(1|true|yes|on)$/i.test(process.env.PI_OFFLINE ?? ""),
      });
      const unsubscribe = footerData.onBranchChange(() => {
        void git.refresh(true);
      });
      const stopClock = () => {
        clearInterval(timer);
        timer = undefined;
      };
      // Each installed footer owns its subscriptions, timer and Git process lifetime.
      const instance: ActiveFooter = {
        refreshGit(force) {
          void git.refresh(force);
        },
        requestRender,
        syncClock() {
          if (disposed || !task.isWorking) {
            stopClock();
            return;
          }
          if (timer) return;
          timer = setInterval(requestRender, 1_000);
          timer.unref();
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          unsubscribe();
          stopClock();
          if (footer === instance) footer = undefined;
          closing = Promise.allSettled([closing, git.dispose()]).then(() => {});
        },
        invalidate() {
          if (!disposed) stats = undefined;
        },
        render(width: number): string[] {
          if (disposed || !ctx) return ["", ""];
          const snapshot = task.snapshot();
          const pulse =
            process.env.PI_STATUSLINE_NO_ANIMATION !== "1" &&
            snapshot.state === "working" &&
            Math.floor((snapshot.elapsedMs ?? 0) / 1000) % 2 === 1;
          return renderFooter(
            {
              git: git.snapshot,
              ...getStats(ctx),
              provider: ctx.model?.provider ?? "",
              model: ctx.model?.id ?? "no model",
              thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
              task: snapshot,
            },
            width,
            ctx.ui.theme,
            pulse,
          );
        },
      };
      footer = instance;
      git.start();
      instance.syncClock();
      return instance;
    });
  };

  pi.on("session_start", (_event, context) => {
    if (context.mode !== "tui") return;
    stats = undefined;
    task.restore(context.sessionManager.getBranch());
    if (enabled) install(context);
  });
  pi.on("session_shutdown", async () => {
    footer?.dispose();
    await closing;
    ctx = undefined;
  });
  const startTask = (context: ExtensionContext, modelRequest = false) => {
    if (context.mode !== "tui") return;
    ctx = context;
    if (modelRequest) task.requestStart();
    else task.start();
    footer?.syncClock();
    changed();
  };
  pi.on("before_agent_start", (_event, context) => startTask(context));
  pi.on("agent_start", (_event, context) => startTask(context));
  pi.on("turn_start", (_event, context) => startTask(context, true));
  pi.on("message_end", (event, context) => {
    if (context.mode !== "tui") return;
    ctx = context;
    if (event.message.role === "assistant") task.response(event.message);
    // Render is deferred by the TUI until the finalized message has been persisted.
    stats = undefined;
    changed();
  });
  pi.on("tool_execution_end", (_event, context) => {
    if (context.mode !== "tui") return;
    footer?.refreshGit();
  });
  pi.on("agent_settled", (event, context) => {
    if (context.mode !== "tui") return;
    ctx = context;
    const result = task.settle(event.aborted);
    footer?.syncClock();
    if (result) pi.appendEntry(TASK_ENTRY, result);
    stats = undefined;
    footer?.refreshGit(true);
    changed();
  });
  // agent_end is deliberately NOT used: recovery and queued continuations may still follow it.
  pi.on("session_tree", (_event, context) => {
    if (context.mode !== "tui") return;
    ctx = context;
    task.restore(context.sessionManager.getBranch());
    footer?.syncClock();
    stats = undefined;
    changed();
  });
  const refreshStats = (_event: unknown, context: ExtensionContext) => {
    if (context.mode !== "tui") return;
    ctx = context;
    stats = undefined;
    changed();
  };
  pi.on("session_compact", refreshStats);
  pi.on("session_compact_failed", refreshStats);
  pi.on("model_select", refreshStats);
  pi.on("thinking_level_select", refreshStats);

  pi.registerCommand("footer", {
    description: "Toggle the pi-bar footer, or explicitly turn it on | off",
    handler: async (args, context) => {
      if (context.mode !== "tui") {
        if (context.hasUI) context.ui.notify("The pi-bar footer requires interactive terminal mode.", "info");
        return;
      }
      const action = args.trim() || (enabled ? "off" : "on");
      if (action === "off") {
        enabled = false;
        // Pi disposes the old footer when replacing it. If another extension has
        // already replaced ours, leave theirs installed.
        if (footer) context.ui.setFooter(undefined);
      } else if (action === "on") {
        enabled = true;
        if (!footer) install(context);
      } else {
        context.ui.notify("/footer [on|off]", "info");
      }
    },
  });
}
