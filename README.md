# pi-bar

基于已确认的 `footer-prototype.html` 实现的 pi 双行 footer。适配 **pi 1.5.2**，无需图标字体、编译步骤或额外运行时依赖。

```text
atlas │ main │ 3 modified · 1 staged · 2 untracked │ 2 ahead             openai-codex/gpt-5.4 · high
182k/500k ▰▰▰▰▰▰▰▰ │ ↑217k · ↓12k │ cache 92% │ $0.050                  ● working │ 03:09 · 42 tok/s
```

实际使用语义颜色区分指标、已用和空闲 Cells；上面的纯文本仅展示结构。目录与分支统一用 `│` 分隔，模型显示为 `provider/model-id`。Cells 默认 8 格，窄屏逐级缩短至 6 / 4 格；Line 保持 12 / 8 / 4 格。终端宽度不足时逐级缩短名称、缩短 meter、隐藏次要指标，不增加第三行或让两侧重叠。

## 试用 / 安装

在 `D:/projects/pi-bar` 目录启动一个新的 pi 进程：

```sh
pi -e .
```

也可以从任意项目加载绝对路径：

```sh
pi -e D:/projects/pi-bar
```

以上只影响该次运行。安装到用户级，供所有项目默认加载：

```sh
pi install D:/projects/pi-bar
```

配置写入 `~/.pi/agent/settings.json`。扩展默认开启，默认使用 Cells meter。然后重启 pi，或在空闲时执行 `/reload`。

本地安装引用原目录，不会复制文件，请保留 `D:/projects/pi-bar`。仅需项目级安装时，加上 `--local`；项目配置需获得信任。另一种方式是将整个包目录（不含 `node_modules`）复制到 `~/.pi/agent/extensions/pi-bar/`；不要只复制 `src/index.ts`。

用户级卸载：

```sh
pi remove D:/projects/pi-bar
```

## 命令

| 命令                         | 行为                                      |
| ---------------------------- | ----------------------------------------- |
| `/statusline`                | 开关双行 footer                           |
| `/statusline on` / `off`     | 启用 / 恢复 pi 默认 footer                |
| `/statusline cells` / `line` | 切换 meter；默认 Cells                    |
| `/statusline refresh`        | 立即刷新本地 Git；不绕过网络退避          |
| `/statusline statuses`       | 查看其他扩展通过 `setStatus()` 提供的状态 |

这些选择只保留到当前扩展运行时结束。`PI_STATUSLINE_NO_ANIMATION=1` 可关闭 Working 标记的轻微明暗变化；耗时仍每秒刷新。

## 指标口径

- **Context**：调用 `ctx.getContextUsage()`，显示当前占用 / 当前容量，不是累计输入；压缩后如果 pi 暂时无法确认占用，显示 `?/500k`，不伪装成 0。不足 70% 为蓝色，70% 起为琥珀色，90% 起为珊瑚红。没有额外的 context 标签或百分比。
- **↑ / ↓**：分别表示输入 / 输出，为整个 session 文件的累计用量，与 pi 全会话统计范围一致，包括其他树分支、压缩摘要、分支摘要、cache warming 和工具上报的嵌套模型用量。`↑` 不含单独计数的 cache read/write；推理 token 已包含在 `↓`，不重复相加。
- **cache**：最近一条主模型响应的 `cacheRead / (input + cacheRead + cacheWrite)`；没有可计算数据时隐藏。不能从未报告的 cacheWrite 推断“没有写缓存”。
- **$**：session 累计 `usage.cost.total`，默认独立成组，三位小数。以 provider 报告或 pi 的价格估算为基础，不保证等于账单；未配置价格时可能是 `$0.000`。
- **耗时**：从任务开始到 `agent_settled`，包括工具、等待、自动重试、压缩恢复和连续排队消息；不是从 `agent_end` 提前结束。使用补零的 `hh:mm:ss`，省略尚未达到的高位：9 秒为 `09`，3 分 9 秒为 `03:09`，1 小时 23 分 33 秒为 `01:23:33`。
- **tok/s**：仅使用实际报告的输出 token。Working 显示本任务最近完成的一次响应的速率；没有完成响应时显示 `—`。Done 的速率为所有可计时响应的输出 token 总和 / 请求耗时总和，而非各响应速率的简单平均；不再显示 `avg` 字样。请求耗时包含网络等待、prefill 和推理，**排除工具执行时间**；它不是扣除了 TTFT 的纯解码速率。不根据字符数伪造实时 token。
- **任务状态**：`● working`、`✓ done`、`■ aborted`、`× error`、`○ idle`。Aborted/Error 保留最终耗时但不显示完成速率；可恢复的工具错误本身不把整个任务标成 Error。最终指标写入不参与模型上下文的 custom entry，支持 reload/resume 和活动分支恢复；历史中没有测量记录时显示 Idle，不猜测耗时。

## Git 行为与安全边界

- 本地状态使用 `git status --porcelain=v2 --branch -z`。支持 detached HEAD、未创建首个 commit、冲突、重命名、子模块状态和特殊文件名。
- 宽屏显示 modified/staged/untracked/conflicts；窄屏的 dirty 是**唯一文件数**，不会把同时 staged 和 modified 的文件计算两次。冲突和 stale 警告优先保留。
- 比较对象是当前分支真正配置的 upstream，解析其 remote、远端 ref 和本地 tracking ref，不假设 `origin` 或同名分支。没有 upstream 明确显示 `no upstream`；无法计算显示 `upstream unknown`。
- 启动时异步 fetch，成功后每 **3 分钟**刷新。只抓取该 upstream，不执行 pull/push/merge/rebase、prune、标签或子模块 fetch，不修改工作区或索引，不写 `FETCH_HEAD`。显式禁用 prune/prune-tags，不继承用户配置中的自动清理行为。
- 本地 upstream（remote 为 `.`）不 fetch；异常 refspec 如果会覆盖本地 branch/tag 则拒绝自动 fetch。非 Git 目录、无 upstream、print/JSON/RPC 模式均不发起网络操作。
- `pi --offline` / `PI_OFFLINE=1` 禁止网络 fetch，但仍显示本地状态与 `remote cached` 标记。
- 本地轮询间隔 5 秒，同时响应 branch-change、工具结束和任务结束。Git 命令不在 `render()` 内运行，事件回调不等待网络。
- fetch 最长 15 秒，本地命令最长 4 秒，输出最多 2 MiB；禁止交互式认证，SSH 使用 BatchMode、严格 known-host 检查、10 秒连接超时。自动 fetch 使用 OpenSSH，而不沿用自定义 `GIT_SSH_COMMAND`；需要特殊 SSH 包装器的环境可能显示 stale。
- fetch 不重叠。失败后显示 `remote stale` 并保留缓存比较，按 3 / 6 / 12 / 24 / 30 分钟退避；恢复成功后回到 3 分钟。初次成功刷新之前显示 `remote cached`，不把本地 tracking ref 当成实时远端数据。
- 关闭 footer、替换 footer、reload、切换会话或退出会停止定时器、取消命令并清理进程树。

## 兼容性

- 严格两行；不会追加 pi 默认的第三行 extension statuses，可用 `/statusline statuses` 查看。
- `setFooter()` 是替换式 API，多个 footer 扩展不能自动合并；最后设置者生效。`off` 恢复的是 pi 默认 footer，而不是其他扩展此前的 footer。
- 颜色使用原型的深/浅两套语义 palette，随 pi 主题的 appearance 切换；不修改主题或终端背景。普通 Unicode 字符，使用 pi 的终端列宽工具处理 CJK、ANSI 和截断。
- 不改变默认 working loader、编辑器、工具或模型请求。

## 开发与验证

```sh
cd D:/projects/pi-bar
npm install
npm run check
```

`npm run check` 依次执行格式检查、TypeScript 严格类型检查和测试；`npm run format` 统一格式，HTML 原型不参与格式化。

运行时由 pi 提供 `@earendil-works/pi-*`；peer dependencies 不打包。开发时应使用与目标 pi 版本一致的 peer dependencies。也可先执行 `npm ci --legacy-peer-deps` 只安装开发工具，再将本机 pi 安装目录中的三个 peer 包链接到 `node_modules/@earendil-works/`。

已在 Windows / Node 24 / pi 1.5.2 验证：

- TypeScript 严格类型检查；40 个自动测试，包含 300 组宽度/任务状态/主题/meter 布局组合。
- 真实临时 Git 仓库：配置不同名 upstream、启动 fetch、ahead/behind、冲突、重命名、staged+unstaged、detached HEAD；fetch 前后工作区和索引一致。
- 模拟失败退避、切换 upstream、取消、离线模式、延迟响应和并发清理；真实超时进程树终止、输出限额和 prune 配置隔离。
- footer 重复开关、替换清理、缓存失效、损坏历史数据和非法宽度/用量的回归测试。
- 初版已验证真实 pi ConPTY 终端：无本地 `node_modules` 时加载整个包、两行显示、Cells/Line、120↔60 列 resize、`/reload`、off/on、正常退出。

未调用收费模型接口；用量和任务生命周期通过事件测试验证。实际 provider 的 usage 完整性取决于其报告能力。

## 结构

```text
src/index.ts     pi 生命周期、footer 安装与清理、命令
src/git.ts       porcelain 解析、后台状态与安全 fetch
src/git-process.ts  有界 Git 进程执行、超时与进程树清理
src/metrics.ts   session 用量与任务计时
src/render.ts    两行响应式布局、语义颜色和 terminal-width 处理
test/           单元、事件集成与真实 Git 测试
footer-prototype.html  已确认的 HTML 原型
```
