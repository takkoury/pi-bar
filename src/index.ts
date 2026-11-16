import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GitMonitor } from "./git.ts";
import { sessionUsage, TASK_ENTRY, TaskTracker } from "./metrics.ts";
import { renderFooter, type FooterData } from "./render.ts";

interface ActiveFooter {
  git: GitMonitor;
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

export default function bar(pi: ExtensionAPI): void {
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
    if (context.mode !== "tui") return;
    ctx = context;
    footer?.dispose();
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
        git,
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
      };
      footer = instance;
      git.start();
      instance.syncClock();
      return {
        dispose: instance.dispose,
        invalidate() {
          stats = undefined;
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
  const start = (context: ExtensionContext) => {
    if (context.mode !== "tui") return;
    ctx = context;
    task.start();
    footer?.syncClock();
    changed();
  };
  pi.on("before_agent_start", (_event, context) => {
    start(context);
  });
  pi.on("agent_start", (_event, context) => {
    start(context);
  });
  pi.on("turn_start", (_event, context) => {
    if (context.mode !== "tui") return;
    start(context);
    task.requestStart();
  });
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
    ctx = context;
    void footer?.git.refresh();
  });
  pi.on("agent_settled", (event, context) => {
    if (context.mode !== "tui") return;
    ctx = context;
    const wasWorking = task.isWorking;
    const result = task.settle(event.aborted);
    footer?.syncClock();
    if (wasWorking) pi.appendEntry(TASK_ENTRY, result);
    stats = undefined;
    void footer?.git.refresh(true);
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
  const refreshStats = (context: ExtensionContext) => {
    if (context.mode !== "tui") return;
    ctx = context;
    stats = undefined;
    changed();
  };
  pi.on("session_compact", (_event, context) => {
    refreshStats(context);
  });
  pi.on("session_compact_failed", (_event, context) => {
    refreshStats(context);
  });
  pi.on("model_select", (_event, context) => {
    refreshStats(context);
  });
  pi.on("thinking_level_select", (_event, context) => {
    refreshStats(context);
  });

  pi.registerCommand("bar", {
    description: "Toggle pi-bar, or explicitly turn it on | off",
    handler: async (args, context) => {
      if (context.mode !== "tui") {
        if (context.hasUI) context.ui.notify("pi-bar requires interactive terminal mode.", "info");
        return;
      }
      const action = args.trim() || (enabled ? "off" : "on");
      if (action === "off") {
        enabled = false;
        footer?.dispose();
        context.ui.setFooter(undefined);
      } else if (action === "on") {
        enabled = true;
        if (!footer) install(context);
      } else {
        context.ui.notify("/bar [on|off]", "info");
      }
    },
  });
}
