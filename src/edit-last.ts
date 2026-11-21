import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const command = "pi-bar-edit-last";
const description = "修改当前分支的上一条提问";

export default function registerEditLast(pi: ExtensionAPI): void {
  pi.registerShortcut("f2", {
    description,
    handler: (ctx) => {
      if (ctx.mode !== "tui") return;
      // Only commands get navigateTree. Do not dispatch an unresolved slash command as a model prompt.
      if (!pi.getCommands().some((c) => c.source === "extension" && c.name === command)) {
        ctx.ui.notify(`/${command} 命令名冲突，请检查已加载的扩展。`, "warning");
        return;
      }
      pi.sendUserMessage(`/${command}`, { expandPromptTemplates: true });
    },
  });

  pi.registerCommand(command, {
    description,
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (ctx.ui.getEditorText() !== "") {
        ctx.ui.notify("输入框已有草稿，未取回消息。请先保存或清空草稿。", "info");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("请先按 Esc 中断回答，等 Pi 空闲后再取回消息。", "info");
        return;
      }
      const target = ctx.sessionManager.getBranch().findLast((e) => e.type === "message" && e.message.role === "user");
      if (target?.type !== "message" || target.message.role !== "user") {
        ctx.ui.notify("当前分支还没有用户提问。", "info");
        return;
      }
      const { content } = target.message;
      if (typeof content !== "string" && content.some((block) => block.type !== "text")) {
        ctx.ui.notify("上一条提问包含附件，无法完整放回输入框；会话位置未变。", "warning");
        return;
      }
      // Pi treats navigation to the current leaf as a no-op. An interrupted prompt may have no reply yet.
      if (ctx.sessionManager.getLeafId() === target.id) pi.appendEntry("pi-bar:edit-last-anchor", null);
      // Target the user entry, not its parent: Pi restores its text AND moves the leaf to its parent.
      const result = await ctx.navigateTree(target.id, { summarize: false });
      if (result.cancelled) ctx.ui.notify("取回消息已取消。", "info");
    },
  });
}
