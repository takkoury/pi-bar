import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StdinBuffer } from "@earendil-works/pi-tui";

const ENABLE_FOCUS = "\x1b[?1004h";
const DISABLE_FOCUS = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BELL = "\x07";

export default function registerNotify(pi: ExtensionAPI): void {
  let enabled = true;
  let dispose: (() => void) | undefined;
  let unfocused = false;
  let running = false;
  let responseAborted = false;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || dispose) return;
    const input = new StdinBuffer();
    // Fullscreen Pi consumes focus reports before extension input handlers. Observe
    // a separate copy of stdin so Pi still sees its own input unchanged.
    input.on("data", (sequence) => {
      if (sequence === FOCUS_OUT) unfocused = true;
      if (sequence === FOCUS_IN) unfocused = false;
    });
    const observe = (data: Buffer | string) => input.process(data);
    process.stdin.prependListener("data", observe);
    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (data === FOCUS_IN || data === FOCUS_OUT) return { consume: true };
    });
    process.stdout.write(ENABLE_FOCUS);
    dispose = () => {
      process.stdout.write(DISABLE_FOCUS);
      unsubscribe();
      process.stdin.off("data", observe);
      input.destroy();
      unfocused = running = responseAborted = false;
      dispose = undefined;
    };
  });

  pi.on("session_shutdown", () => dispose?.());
  pi.on("agent_start", () => {
    if (!dispose || running) return;
    running = true;
    responseAborted = false;
    // Pi can restart its renderer or switch from fullscreen to regular between runs.
    process.stdout.write(ENABLE_FOCUS);
  });
  pi.on("message_end", (event) => {
    if (running && event.message.role === "assistant") responseAborted = event.message.stopReason === "aborted";
  });
  pi.on("agent_settled", (event) => {
    if (!running) return;
    running = false;
    if (enabled && unfocused && !event.aborted && !responseAborted) process.stdout.write(BELL);
  });

  pi.registerCommand("notify", {
    description: "Toggle background task reminders, or explicitly turn them on | off",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Background task reminders require interactive terminal mode.", "info");
        return;
      }
      const action = args.trim() || (enabled ? "off" : "on");
      if (action !== "on" && action !== "off") {
        ctx.ui.notify("/notify [on|off]", "info");
        return;
      }
      // Keep tracking focus while muted so re-enabling needs no fresh focus change.
      enabled = action === "on";
      ctx.ui.notify(`Background task reminders: ${action}`, "info");
    },
  });
}
