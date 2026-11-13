# pi-bar

基于 `footer-prototype.html` 初版布局实现的 pi 双行 footer，当前格式与配色见下文。适配 **pi 1.5.2**，无需图标字体、编译步骤或额外运行时依赖。

```text
atlas │ main │ 3 modified · 1 staged · 2 untracked │ 2 ahead                                  [openai] gpt-6-astra [low]
182k▰▰▰▰▰▰▰▰ 500k 36% │ ↑217k ↓12k │ cache 92% │ $0.050                                      ● working │ 01:30:15 42tk/s
```

实际使用语义颜色区分指标、已用和空闲 Cells；上面的纯文本仅展示结构。目录与分支统一用 `│` 分隔，模型显示为 `[provider] model_id [thinking level]`，方括号和各部分之间的单个空格均实际显示。Cells 默认 8 格，窄屏逐级缩短至 6 / 4 格；Line 保持 12 / 8 / 4 格。终端宽度不足时逐级缩短名称、缩短 meter、隐藏次要指标，不增加第三行或让两侧重叠。

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

- **Context**：调用 `ctx.getContextUsage()`，按 `当前占用<进度条> 当前容量 占用百分比` 显示，例如 `54.4k▰▰▰▰▰▰▰▰ 272k 20%`。占用与进度条之间没有空格，进度条、容量、百分比之间各一个空格。百分比按实际占用 / 容量计算并四舍五入至整数，不是累计输入。压缩后如果 pi 暂时无法确认占用，显示 `?▰▰▰▰▰▰▰▰ 500k ?%`，不伪装成 0。不足 70% 为蓝色，70% 起为琥珀色，90% 起为珊瑚红。
- **↑ / ↓**：分别表示输入 / 输出，中间仅一个空格，例如 `↑129.7k ↓35.5k`。统计整个 session 文件的累计用量，与 pi 全会话统计范围一致，包括其他树分支、压缩摘要、分支摘要、cache warming 和工具上报的嵌套模型用量。`↑` 不含单独计数的 cache read/write；推理 token 已包含在 `↓`，不重复相加。
- **cache**：最近一条主模型响应的 `cacheRead / (input + cacheRead + cacheWrite)`；没有可计算数据时隐藏。不能从未报告的 cacheWrite 推断“没有写缓存”。
- **$**：session 累计 `usage.cost.total`，默认独立成组，三位小数。以 provider 报告或 pi 的价格估算为基础，不保证等于账单；未配置价格时可能是 `$0.000`。
- **耗时**：从任务开始到 `agent_settled`，包括工具、等待、自动重试、压缩恢复和连续排队消息；不是从 `agent_end` 提前结束。Working 时使用补零的 `hh:mm:ss`，省略尚未达到的高位，例如 `05`、`02:13`、`01:30:15`。停止计时后（Done / Aborted / Error）改为无空格的 `05s`、`05m24s`、`01h30m15s`，只省略未达到的高位，保留低位的零值。耗时使用柔灰色。
- **tk/s**：使用淡紫色，与灰色耗时区分；缺失值 `—` 仍使用灰色。紧跟数字显示，例如 `105tk/s`；与耗时之间仅一个空格，例如 `30s 70tk/s`。仅使用实际报告的输出 token。Working 显示本任务最近完成的一次响应的速率；没有完成响应时显示 `—`。Done 的速率为所有可计时响应的输出 token 总和 / 请求耗时总和，而非各响应速率的简单平均；不再显示 `avg` 字样。请求耗时包含网络等待、prefill 和推理，**排除工具执行时间**；它不是扣除了 TTFT 的纯解码速率。不根据字符数伪造实时 token。
- **任务状态**：`● working`、`✓ done`、`■ aborted`、`× error`、`○ idle`。Aborted/Error 保留最终耗时但不显示完成速率；可恢复的工具错误本身不把整个任务标成 Error。最终指标写入不参与模型上下文的 custom entry，支持 reload/resume 和活动分支恢复；历史中没有测量记录时显示 Idle，不猜测耗时。

## 配色

蓝色表示容量，紫色表示模型计算，绿黄红表示状态；正常静态信息用明暗建立层级，不给每个指标单独分配强调色。

| 用途                                                                 | 深色主题  | 浅色主题  |
| -------------------------------------------------------------------- | --------- | --------- |
| 目录、分支、模型 ID、cache 数值、费用                                | `#E5E8EE` | `#293445` |
| provider、方括号、容量上限、耗时、cache 标签、未知值、clean / synced | `#9AA6B5` | `#5E6C7C` |
| 分隔符                                                               | `#667181` | `#7C899A` |
| Context 空闲格                                                       | `#444D5A` | `#C3CEDA` |
| 正常 Context、Working、ahead                                         | `#98BCE5` | `#376BA2` |
| 输入、输出、吞吐速度                                                 | `#C2ABE7` | `#77549B` |
| staged、Done                                                         | `#9AC9B3` | `#34715C` |
| modified、untracked、behind、stale、Aborted、Context ≥70%            | `#E3B574` | `#996019` |
| conflicts、Error、Context ≥90%                                       | `#E68F91` | `#B2434E` |

Context 只对当前用量、已占用格和百分比应用阈值色；容量上限始终灰色。数字与单位保持同色。状态色只影响状态，不扩散到耗时或速度。

Thinking level 单独使用逐级增强的紫色阶梯，仅等级文字着色，两侧方括号保持灰色；不加粗或闪烁，不用警告色暗示高等级异常。未知等级按原文显示并回退灰色。

| Thinking level | 深色主题  | 浅色主题  |
| -------------- | --------- | --------- |
| off            | `#9AA6B5` | `#5E6C7C` |
| minimal        | `#AAA4B3` | `#706779` |
| low            | `#B4A6C7` | `#705C86` |
| medium         | `#BBA5DA` | `#704E99` |
| high           | `#C5A3ED` | `#6D3DAD` |
| xhigh          | `#D0A6FF` | `#6627BF` |
| max            | `#E0BAFF` | `#5912CC` |

文字色在原型深色背景 `#1C1E22` / 浅色背景 `#F9FAFB` 上的对比度均 ≥4.5:1，Thinking 各档对比度逐级提高。分隔符与空闲格属于弱化结构，不作为正文色；实际终端背景由用户控制，其他背景下需单独核对可读性。

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
- 颜色使用上面的深/浅两套语义 palette，随 pi 主题的 appearance 切换；不修改主题或终端背景。普通 Unicode 字符，使用 pi 的终端列宽工具处理 CJK、ANSI 和截断。
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

- TypeScript 严格类型检查；47 个自动测试，包含 300 组宽度/任务状态/主题/meter 布局组合。
- 真实临时 Git 仓库：配置不同名 upstream、启动 fetch、ahead/behind、冲突、重命名、staged+unstaged、detached HEAD；fetch 前后工作区和索引一致。
- 模拟失败退避、切换 upstream、取消、离线模式、延迟响应和并发清理；真实超时进程树终止、输出限额和 prune 配置隔离。
- footer 重复开关、替换清理、缓存失效、损坏历史数据和非法宽度/用量的回归测试。
- 深浅主题的实际 ANSI 染色、Context 局部阈值色、Thinking 全等级与未知值回退、窄屏染色和参考背景对比度。
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
footer-prototype.html  初版 HTML 布局原型（历史参考）
```
