import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseColor, styleText, visibleWidth } from "@earendil-works/pi-tui";
import {
  cleanText,
  contextTone,
  formatDuration,
  formatNumber,
  layoutFooter,
  plain,
  renderFooter,
  taskVariants,
} from "../src/render.ts";
import { example } from "./fixtures.ts";

const theme = (appearance: "dark" | "light") =>
  ({
    appearance,
    style: (text: string, options: Parameters<Theme["style"]>[1]) =>
      styleText(text, options as Parameters<typeof styleText>[1], "truecolor"),
  }) as Theme;

const palettes = {
  dark: {
    background: "#1c1e22",
    text: "#e5e8ee",
    dim: "#9aa6b5",
    separator: "#667181",
    track: "#444d5a",
    blue: "#98bce5",
    lavender: "#c2abe7",
    green: "#9ac9b3",
    amber: "#e3b574",
    red: "#e68f91",
  },
  light: {
    background: "#f9fafb",
    text: "#293445",
    dim: "#5e6c7c",
    separator: "#7c899a",
    track: "#c3ceda",
    blue: "#376ba2",
    lavender: "#77549b",
    green: "#34715c",
    amber: "#996019",
    red: "#b2434e",
  },
};
const expectColor = (row: string, text: string, hex: string) => {
  assert.ok(
    row.includes(styleText(text, { fg: parseColor(hex), dim: false }, "truecolor")),
    `${JSON.stringify(text)}: ${hex}`,
  );
};
const luminance = (hex: string) => {
  const linear = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};
const contrast = (foreground: string, background: string) => {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test("wide layout uses consistent separators, provider prefix and compact metrics", () => {
  const data = example();
  const [top, bottom] = layoutFooter(data, 160);
  assert.equal(plain(top.left), "atlas │ main │ 3 modified · 1 staged · 2 untracked │ 2 ahead");
  assert.equal(plain(top.right), "[openai-codex] gpt-5.4 [high]");
  assert.equal(plain(bottom.left), "182k▰▰▰▰▰▰▰▰ 500k 36% │ ↑217k ↓12k │ cache 92% │ $0.050");
  assert.equal(plain(bottom.right), "● working │ 12 42tk/s");
  assert.equal(plain(taskVariants({ state: "done", elapsedMs: 48000, speed: 56 })[0].parts), "✓ done │ 48s 56tk/s");
});

test("context, model and token totals preserve literal brackets and single spaces", () => {
  const data = example();
  data.context = { tokens: 15000, capacity: 272000 };
  data.provider = "openai";
  data.model = "gpt-6-astra";
  data.thinking = "low";
  data.usage.input = 129700;
  data.usage.output = 35500;
  const [top, bottom] = layoutFooter(data, 160);
  assert.equal(plain(top.right), "[openai] gpt-6-astra [low]");
  // Percentage is calculated from actual usage, not the rounded labels.
  assert.equal(plain(bottom.left), "15k▰▰▰▰▰▰▰▰ 272k 6% │ ↑129.7k ↓35.5k │ cache 92% │ $0.050");
  data.context.tokens = 54400;
  assert.ok(plain(layoutFooter(data, 160)[1].left).startsWith("54.4k▰▰▰▰▰▰▰▰ 272k 20% │ "));
});

test("all widths, states, palettes and meters render exactly two bounded rows", () => {
  for (const state of ["working", "done", "aborted", "error", "idle"] as const)
    for (const meter of ["cells", "line"] as const)
      for (const appearance of ["dark", "light"] as const)
        for (const columns of [0, 1, 2, 4, 8, 15, 20, 30, 40, 60, 80, 100, 120, 160, 240]) {
          const data = example();
          data.task.state = state;
          data.task.elapsedMs = 5415000;
          data.meter = meter;
          data.git.repo = "仓库-🧪-e\u0301-with-a-long-name";
          data.git.branch = "feature/very-long-branch-for-terminal-width-check";
          data.model = "claude-opus-4-6-with-an-extra-long-model-name";
          const rows = renderFooter(data, columns, theme(appearance), true);
          assert.equal(rows.length, 2);
          rows.forEach((line) => {
            assert.ok(visibleWidth(line) <= columns);
            assert.ok(!/[\r\n]/.test(line));
          });
          const layout = layoutFooter(data, columns);
          for (let i = 0; i < 2; i++) {
            assert.ok(!/ {2}/.test(plain(layout[i].right)));
            if (layout[i].right.length) assert.equal(visibleWidth(rows[i]), columns);
          }
        }
});

test("context thresholds, unknown context, and out-of-capacity values", () => {
  for (const [percent, tone] of [
    [0, "blue"],
    [69.9, "blue"],
    [70, "amber"],
    [89.9, "amber"],
    [90, "red"],
    [110, "red"],
  ] as const) {
    assert.equal(contextTone(percent), tone);
    const data = example();
    data.context.tokens = percent * 5000;
    const parts = layoutFooter(data, 160)[1].left;
    assert.equal(parts[0].tone, tone);
    assert.ok(plain(parts).startsWith(`${formatNumber(percent * 5000)}▰▰▰▰▰▰▰▰ 500k ${Math.round(percent)}% │ `));
  }
  const data = example();
  data.context.tokens = null;
  assert.ok(plain(layoutFooter(data, 160)[1].left).startsWith("?▰▰▰▰▰▰▰▰ 500k ?% │ "));
  assert.equal(layoutFooter(data, 160)[1].left[0].tone, "dim");
});

test("Git warnings and unique dirty count are protected as space shrinks", () => {
  const data = example();
  data.git.conflicts = 2;
  data.git.remoteState = "stale";
  assert.match(plain(layoutFooter(data, 80)[0].left), /2 conflicts/);
  assert.match(plain(layoutFooter(data, 80)[0].left), /remote stale/);
  assert.match(plain(layoutFooter(data, 30)[0].left), /2 conflicts/);
  data.git.conflicts = 0;
  data.git.remoteState = "fresh";
  assert.match(plain(layoutFooter(data, 50)[0].left), /5 dirty/);
  data.git.upstream = null;
  data.git.ahead = data.git.behind = null;
  const noUpstream = plain(layoutFooter(data, 120)[0].left);
  assert.match(noUpstream, /no upstream/);
  assert.doesNotMatch(noUpstream, /synced/);
  data.git.upstream = "origin/missing";
  assert.match(plain(layoutFooter(data, 120)[0].left), /upstream unknown/);
});

test("no terminal control injection through repo/provider/model/thinking labels", () => {
  const data = example();
  data.git.repo = "evil\x1b[2J\nrepo";
  data.provider = "\x1b[31mprovider\x1b[0m\nname";
  data.model = "\x1b]0;evil title\x07model\tname";
  data.thinking = "\x1b[31mhigh\x1b[0m\n";
  const lines = renderFooter(data, 160, theme("dark")).map(stripVTControlCharacters);
  assert.ok(lines[0].includes("evil repo"));
  assert.ok(lines[0].includes("[provider name] "));
  assert.ok(lines[0].includes("model name [high]"));
  assert.ok(!lines.some((line) => /[\n\t\x1b]/.test(line)));
  assert.equal(cleanText("a\u202eb\r\nc"), "a b c");
});

test("compact model labels retain the provider prefix", () => {
  const data = example();
  data.provider = "anthropic";
  data.model = "claude-opus-4-6-with-an-extra-long-model-name";
  let shortened = false;
  for (const columns of [60, 80, 100, 120, 160, 240]) {
    const label = plain(layoutFooter(data, columns)[0].right);
    if (!label) continue;
    assert.ok(label.startsWith("[anthropic] "), label);
    assert.ok(label.endsWith(" [high]"), label);
    if (label.includes("…")) shortened = true;
  }
  assert.equal(shortened, true);
});

test("Cells uses eight cells with proportional fill; Line keeps its existing length", () => {
  for (const meter of ["cells", "line"] as const) {
    const size = meter === "cells" ? 8 : 12;
    const glyph = meter === "cells" ? "▰" : "━";
    for (const tokens of [0, 250000, 500000, 600000, null]) {
      const data = example();
      data.meter = meter;
      data.context.tokens = tokens;
      const bar = layoutFooter(data, 160)[1].left.filter((part) => part.text.includes(glyph));
      assert.equal(plain(bar).length, size);
      const filled = bar.filter((part) => part.tone !== "track");
      const expected = tokens === null ? 0 : Math.round(Math.min(tokens / 500000, 1) * size);
      assert.equal(plain(filled).length, expected);
    }
  }
  // The default mode is Cells; narrow layouts may shorten it further, never lengthen it.
  for (const columns of [40, 60, 80, 120, 160]) {
    const text = plain(layoutFooter(example(), columns)[1].left);
    assert.ok((text.match(/▰/g) ?? []).length <= 8);
  }
});

test("invalid terminal widths render empty rows rather than throwing", () => {
  for (const columns of [NaN, Infinity, -Infinity, -1]) {
    assert.deepEqual(renderFooter(example(), columns, theme("dark")), ["", ""]);
  }
  const rows = renderFooter(example(), 60.9, theme("light"));
  assert.ok(rows.every((row) => visibleWidth(row) <= 60));
});

test("invalid context values are displayed as unknown", () => {
  for (const tokens of [NaN, Infinity, -1]) {
    const data = example();
    data.context.tokens = tokens;
    assert.ok(plain(layoutFooter(data, 160)[1].left).startsWith("?▰▰▰▰▰▰▰▰ 500k ?% │ "));
  }
  for (const capacity of [NaN, Infinity, -1, 0]) {
    const data = example();
    data.context.capacity = capacity;
    assert.ok(plain(layoutFooter(data, 160)[1].left).startsWith("?▰▰▰▰▰▰▰▰ ? ?% │ "));
  }
});

test("stopped task metrics use unit suffixes and one space before compact throughput", () => {
  for (const [elapsedMs, clock, units] of [
    [5000, "05", "05s"],
    [30000, "30", "30s"],
    [133000, "02:13", "02m13s"],
    [324000, "05:24", "05m24s"],
    [5415000, "01:30:15", "01h30m15s"],
  ] as const) {
    assert.equal(
      plain(taskVariants({ state: "working", elapsedMs, speed: 70 })[0].parts),
      `● working │ ${clock} 70tk/s`,
    );
    assert.equal(plain(taskVariants({ state: "done", elapsedMs, speed: 105 })[0].parts), `✓ done │ ${units} 105tk/s`);
    assert.equal(plain(taskVariants({ state: "aborted", elapsedMs, speed: 105 })[0].parts), `■ aborted │ ${units} —`);
    assert.equal(plain(taskVariants({ state: "error", elapsedMs, speed: 105 })[0].parts), `× error │ ${units} —`);
  }
  assert.equal(plain(taskVariants({ state: "done", elapsedMs: null, speed: null })[0].parts), "✓ done │ — —");
  assert.equal(plain(taskVariants({ state: "idle", elapsedMs: null, speed: null })[0].parts), "○ idle");
});

test("task time and throughput have distinct colors in both themes; unavailable rates stay dim", () => {
  for (const [appearance, timeColor, speedColor] of [
    ["dark", "#9aa6b5", "#c2abe7"],
    ["light", "#5e6c7c", "#77549b"],
  ] as const) {
    const palette = theme(appearance);
    for (const state of ["working", "done", "aborted", "error"] as const) {
      for (const speed of [null, 0, 70]) {
        const data = example();
        data.task = { state, elapsedMs: 324000, speed };
        const row = renderFooter(data, 160, palette)[1];
        const time = state === "working" ? "05:24" : "05m24s";
        const hasSpeed = speed !== null && (state === "working" || state === "done");
        const rate = hasSpeed ? `${speed}tk/s` : "—";
        assert.ok(row.includes(palette.style(time, { fg: parseColor(timeColor), dim: false })));
        assert.ok(row.includes(palette.style(rate, { fg: parseColor(hasSpeed ? speedColor : timeColor), dim: false })));
      }
    }
  }
});

test("Git identities stay neutral while actionable states retain semantic colors at all sizes", () => {
  for (const appearance of ["dark", "light"] as const) {
    const palette = palettes[appearance];
    const data = example();
    data.git.behind = 1;
    let row = renderFooter(data, 240, theme(appearance))[0];
    for (const [text, tone] of [
      ["atlas", "text"],
      ["main", "text"],
      [" │ ", "separator"],
      [" · ", "separator"],
      ["3 modified", "amber"],
      ["1 staged", "green"],
      ["2 untracked", "amber"],
      ["2 ahead", "blue"],
      ["1 behind", "amber"],
    ] as const)
      expectColor(row, text, palette[tone]);

    data.git.conflicts = 2;
    data.git.localStale = true;
    data.git.remoteState = "stale";
    row = renderFooter(data, 240, theme(appearance))[0];
    expectColor(row, "2 conflicts", palette.red);
    expectColor(row, "status stale", palette.amber);
    expectColor(row, "remote stale", palette.amber);
    for (const columns of [30, 60, 80, 160]) {
      const parts = layoutFooter(data, columns)[0].left;
      for (const part of parts) {
        if (part.text === "main") assert.equal(part.tone, "text");
        if (part.text === "2 conflicts") assert.equal(part.tone, "red");
        if (part.text.endsWith("stale")) assert.equal(part.tone, "amber");
      }
    }

    Object.assign(data.git, {
      conflicts: 0,
      modified: 0,
      staged: 0,
      untracked: 0,
      dirtyFiles: 0,
      ahead: 0,
      behind: 0,
      localStale: false,
      remoteState: "fresh",
    });
    row = renderFooter(data, 160, theme(appearance))[0];
    expectColor(row, "clean", palette.dim);
    expectColor(row, "synced", palette.dim);
    data.git.kind = "error";
    for (const columns of [15, 160]) {
      expectColor(renderFooter(data, columns, theme(appearance))[0], "Git unavailable", palette.amber);
    }
  }
});

test("capacity limits and ordinary metrics stay neutral while context usage follows thresholds", () => {
  for (const appearance of ["dark", "light"] as const) {
    const palette = palettes[appearance];
    for (const key of ["text", "dim", "blue", "lavender", "green", "amber", "red"] as const) {
      assert.ok(contrast(palette[key], palette.background) >= 4.5, `${appearance}: ${key}`);
    }
    for (const meter of ["cells", "line"] as const) {
      for (const percent of [0, 69.9, 70, 89.9, 90, 110, null]) {
        const data = example();
        data.meter = meter;
        data.context.tokens = percent === null ? null : percent * 5000;
        const tone = percent === null ? "dim" : percent >= 90 ? "red" : percent >= 70 ? "amber" : "blue";
        const parts = layoutFooter(data, 160)[1].left;
        assert.deepEqual(
          parts.slice(0, 5).map((part) => part.tone),
          [tone, tone, "track", "dim", tone],
        );
        const row = renderFooter(data, 160, theme(appearance))[1];
        for (const part of parts.slice(0, 3)) {
          if (part.text) expectColor(row, part.text, part.tone === "track" ? palette.track : palette[tone]);
        }
        expectColor(row, " 500k", palette.dim);
        expectColor(row, ` ${percent === null ? "?" : Math.round(percent)}%`, palette[tone]);
        expectColor(row, "↑217k", palette.lavender);
        expectColor(row, "↓12k", palette.lavender);
        expectColor(row, "cache ", palette.dim);
        expectColor(row, "92%", palette.text);
        expectColor(row, "$0.050", palette.text);
      }
    }
  }
});

test("thinking levels use the approved progressive purple ramp with neutral brackets in both themes", () => {
  const levels = [
    ["off", "#9aa6b5", "#5e6c7c"],
    ["minimal", "#aaa4b3", "#706779"],
    ["low", "#b4a6c7", "#705c86"],
    ["medium", "#bba5da", "#704e99"],
    ["high", "#c5a3ed", "#6d3dad"],
    ["xhigh", "#d0a6ff", "#6627bf"],
    ["max", "#e0baff", "#5912cc"],
  ] as const;
  for (const appearance of ["dark", "light"] as const) {
    const palette = palettes[appearance];
    const data = example();
    data.provider = "anthropic";
    data.model = "claude-opus-4-6-with-an-extra-long-model-name";
    let previousContrast = 0;
    for (const [level, dark, light] of levels) {
      const hex = appearance === "dark" ? dark : light;
      const ratio = contrast(hex, palette.background);
      assert.ok(ratio >= 4.5 && ratio > previousContrast, `${appearance}: ${level}`);
      previousContrast = ratio;
      data.thinking = level;
      for (const columns of [80, 100, 160, 240]) {
        const parts = layoutFooter(data, columns)[0].right;
        assert.ok(parts.length > 0);
        const row = renderFooter(data, columns, theme(appearance))[0];
        expectColor(row, "[anthropic] ", palette.dim);
        expectColor(row, parts[1].text, palette.text);
        expectColor(row, " [", palette.dim);
        expectColor(row, level, hex);
        expectColor(row, "]", palette.dim);
        assert.equal(row, renderFooter(data, columns, theme(appearance), true)[0]);
        assert.ok(plain(parts).endsWith(` [${level}]`));
        assert.ok(visibleWidth(row) <= columns);
      }
    }
    for (const level of ["unknown", "constructor", "__proto__", "toString"]) {
      data.thinking = level;
      expectColor(renderFooter(data, 240, theme(appearance))[0], level, palette.dim);
    }
    data.provider = "";
    data.model = "";
    expectColor(renderFooter(data, 160, theme(appearance))[0], "no model", palette.dim);
  }
});

test("number formatting uses compact, stable units", () => {
  for (const [value, expected] of [
    [0, "0"],
    [999, "999"],
    [1200, "1.2k"],
    [182000, "182k"],
    [1500000, "1.5M"],
  ] as const) {
    assert.equal(formatNumber(value), expected);
  }
});

test("duration uses zero-padded clock fields and omits only unused leading fields", () => {
  for (const [ms, expected] of [
    [0, "00"],
    [999, "00"],
    [1000, "01"],
    [9000, "09"],
    [59000, "59"],
    [59999, "59"],
    [60000, "01:00"],
    [61000, "01:01"],
    [189000, "03:09"],
    [3599999, "59:59"],
    [3600000, "01:00:00"],
    [3660000, "01:01:00"],
    [5013000, "01:23:33"],
    [86400000, "24:00:00"],
    [360000000, "100:00:00"],
  ] as const) {
    assert.equal(formatDuration(ms), expected);
  }
});

test("stopped duration has no spaces and keeps zero fields below the highest used unit", () => {
  for (const [ms, expected] of [
    [0, "00s"],
    [999, "00s"],
    [5000, "05s"],
    [60000, "01m00s"],
    [133000, "02m13s"],
    [324000, "05m24s"],
    [3599999, "59m59s"],
    [3600000, "01h00m00s"],
    [3605000, "01h00m05s"],
    [5415000, "01h30m15s"],
    [86400000, "24h00m00s"],
    [360000000, "100h00m00s"],
  ] as const) {
    assert.equal(formatDuration(ms, "units"), expected);
  }
});
