# 开发与维护

安装和日常使用见 [README](README.md)。这里记录开发环境、代码职责和修改时需要保留的约定。

## 准备环境

需要 Git、Node.js 22.18 或更新版本，以及目标版本的 pi。目前主要验证环境是 Windows、Node.js 24、pi 1.5.2。

先安装锁定版本的开发工具：

```sh
npm ci --legacy-peer-deps
```

`@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui` 是 pi 提供的宿主依赖。运行扩展时由 pi 加载；在仓库中直接运行 TypeScript 检查和测试时，需要将这三个包链接到本地 `node_modules/@earendil-works/`。

请链接目标 pi 安装中的包，确保版本一致。不要改写链接指向的宿主文件，也不要把这些包加入 `dependencies` 或复制进仓库。

以下命令只用于尚未建立链接的开发目录。将示例路径替换为本机实际的包目录，其下应包含 `pi-ai`、`pi-coding-agent` 和 `pi-tui`。

Windows PowerShell：

```powershell
$hostPackages = "C:/path/to/pi/node_modules/@earendil-works"
New-Item -ItemType Directory -Force node_modules/@earendil-works | Out-Null
"pi-ai", "pi-coding-agent", "pi-tui" | ForEach-Object {
    New-Item -ItemType Junction -Path "node_modules/@earendil-works/$_" -Target "$hostPackages/$_"
}
```

macOS / Linux：

```sh
host_packages="/absolute/path/to/pi/node_modules/@earendil-works"
mkdir -p node_modules/@earendil-works
for package in pi-ai pi-coding-agent pi-tui; do
  ln -s "$host_packages/$package" "node_modules/@earendil-works/$package"
done
```

用 `npm ls --depth=0` 检查链接和版本，然后运行 `npm run check`。重新执行 `npm ci` 后，需要重新建立这些链接。

## 本地试用

在仓库根目录执行：

```sh
pi -ne -e .
```

用 `pi -ne -e ./src/footer.ts` 或 `pi -ne -e ./src/notify.ts` 可单独试用一个功能。也可以通过 `pi install <仓库绝对路径>` 安装本地版本，修改后在 pi 空闲时执行 `/reload`。本地路径安装引用原目录，不会复制代码。

测试本地版本时，不要同时加载已安装的 GitHub 版本或其他替换状态栏的扩展，以免互相覆盖。没有编译步骤，也不需要生成 `dist/`。

## 目录与职责

保持小而直接的目录结构；不为单个函数增加一层目录或转发模块。

| 路径                       | 职责                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `src/footer.ts`            | 状态栏扩展入口；管理 `/footer`、用量缓存和状态栏资源                |
| `src/notify.ts`            | 提醒扩展入口；管理 `/notify`、终端焦点和任务结束事件                |
| `src/git.ts`               | Git 状态解析、轮询、upstream 比较和后台 fetch 策略                  |
| `src/git-process.ts`       | Git 进程执行、超时、取消和输出限额                                  |
| `src/metrics.ts`           | 会话用量汇总、任务计时、吞吐速度和历史记录恢复                      |
| `src/render.ts`            | 文本格式、配色、Cells 进度条和双行宽度适配；不执行 Git 或启动计时器 |
| `test/extension.test.ts`   | 命令、事件、状态栏生命周期和后台提醒                                |
| `test/git.test.ts`         | Git 解析与监控；模拟时钟和命令，以及临时真实仓库验证                |
| `test/git-process.test.ts` | 进程树终止、取消、无效目录和输出限额                                |
| `test/metrics.test.ts`     | 用量计算、任务状态和恢复校验                                        |
| `test/render.test.ts`      | 文本、宽度限制、颜色和参考背景对比度                                |
| `test/fixtures.ts`         | 测试用消息、会话记录和状态栏数据                                    |
| `assets/`                  | README 使用的实际截图                                               |

模块之间传递快照数据。`GitMonitor` 接受命令执行器和时钟，`TaskTracker` 接受时钟，方便测试不同结果和时间变化；不需要为没有变化的逻辑再增加抽象层。

## 修改约定

- **扩展入口**：每个可独立开关的功能在 `package.json` 的 `pi.extensions` 中单独声明，并默认导出自身的注册函数。入口之间不互相加载；共享代码留在普通模块中，不声明为入口。新增功能时验证它可独立加载，且能在 `pi config --local` 里单独勾选。
- **显示**：固定两行，Cells 按宽度使用 8 / 6 / 4 格。保留字面括号、单空格和现有颜色分工，窄屏优先保留 Git 警告。外部名称必须清理终端控制字符。
- **命令**：`/footer [on|off]` 只控制自定义状态栏，`/notify [on|off]` 只控制后台提醒，无参数时切换。重复开启不能创建重复订阅或计时器；关闭自定义状态栏后恢复 pi 默认状态栏。
- **统计**：累计用量来自整个会话，上下文占用来自 pi；无法确定时显示未知值，不猜测。任务耗时包含工具执行，吞吐速度不包含工具执行。
- **任务结束**：以 `agent_settled` 为准，不用 `agent_end` 提前结束计时。历史任务数据的记录标识是 `pi-bar:task:v1`，改变存储格式前考虑旧记录兼容。
- **Git 安全**：只 fetch 当前 upstream，不自动 pull、push、prune 或覆盖本地分支与标签。保留超时、输出限额、失败退避和非交互认证。
- **资源清理**：计时器、分支订阅和 Git 命令随状态栏实例清理，旧实例不能影响替代它的新实例。后台提醒的焦点监听随交互会话建立和清理，与状态栏的安装、替换无关。
- **运行模式**：仅在 TUI 中安装状态栏和启动后台工作，不影响 print、JSON 或 RPC 模式。
- **配置**：保留 `PI_OFFLINE` 禁止后台 fetch 的行为，以及 `PI_STATUSLINE_NO_ANIMATION=1` 关闭动画的兼容名称。不要提交个人 `.pi/` 配置或改变用户终端背景。

## 验证与提交

```sh
npm run format
npm run check
git diff --check
```

`check` 依次运行 Prettier、TypeScript 和测试。测试不调用收费模型接口；真实 Git 测试使用临时目录和本地远端，不推送到 GitHub。进程测试使用 Git shell alias，在 Windows 上需要 Git for Windows 提供的 shell。

修改某个模块时，优先在对应测试文件中补充回归用例。显示测试通过 `renderFooter` 的最终文本和 ANSI 输出验证行为，不依赖内部的布局候选或颜色片段。

修改显示效果后，还需要在真实 pi 中检查深浅主题、窄屏、工作中与结束后的显示，以及 `/footer` 开关和 `/reload`。有明显变化时更新 `assets/pi-bar-preview.png`，截图只保留输入框和状态栏，避免带入私人对话。

修改后台提醒后，在支持焦点报告和铃声的终端里分别用常规和全屏模式试运行：任务结束前切到其他标签页或应用，应只提醒一次（包括执行过 `/footer off` 的情况）；如果保持焦点、提前切回、主动中止或执行了 `/notify off`，则不应提醒。

修改打包文件清单后，用 `npm pack --dry-run` 确认代码、文档及其引用的图片均被包含，且没有测试、个人配置或开发产物。这里只检查文件清单，不表示包已发布到 npm。

提交前确认改动范围，不把开发依赖链接或本地环境文件带入提交。文件采用 UTF-8、LF 换行；编辑器约定在 `.editorconfig`，最终格式以 Prettier 为准。
