import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { styleText, visibleWidth } from "@earendil-works/pi-tui";
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

test("wide layout uses consistent separators, provider prefix and compact metrics", () => {
  const data = example();
  const [top, bottom] = layoutFooter(data, 160);
  assert.equal(plain(top.left), "atlas │ main │ 3 modified · 1 staged · 2 untracked │ 2 ahead");
  assert.equal(plain(top.right), "openai-codex/gpt-5.4 · high");
  assert.equal(plain(bottom.left), "182k/500k ▰▰▰▰▰▰▰▰ │ ↑217k · ↓12k │ cache 92% │ $0.050");
  assert.equal(plain(bottom.right), "● working │ 12 · 42 tok/s");
  assert.equal(plain(taskVariants({ state: "done", elapsedMs: 48000, speed: 56 })[0].parts), "✓ done │ 48 · 56 tok/s");
});

test("all widths, states, palettes and meters render exactly two bounded rows", () => {
  for (const state of ["working", "done", "aborted", "error", "idle"] as const)
    for (const meter of ["cells", "line"] as const)
      for (const appearance of ["dark", "light"] as const)
        for (const columns of [0, 1, 2, 4, 8, 15, 20, 30, 40, 60, 80, 100, 120, 160, 240]) {
          const data = example();
          data.task.state = state;
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
    assert.equal(layoutFooter(data, 160)[1].left[0].tone, tone);
  }
  const data = example();
  data.context.tokens = null;
  assert.ok(plain(layoutFooter(data, 160)[1].left).startsWith("?/500k "));
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

test("no terminal control injection through repo/provider/model names", () => {
  const data = example();
  data.git.repo = "evil\x1b[2J\nrepo";
  data.provider = "\x1b[31mprovider\x1b[0m\nname";
  data.model = "\x1b]0;evil title\x07model\tname";
  const lines = renderFooter(data, 160, theme("dark")).map(stripVTControlCharacters);
  assert.ok(lines[0].includes("evil repo"));
  assert.ok(lines[0].includes("provider name/"));
  assert.ok(lines[0].includes("model name"));
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
    assert.ok(label.startsWith("anthropic/"), label);
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
    assert.ok(plain(layoutFooter(data, 160)[1].left).startsWith("?/500k "));
  }
  for (const capacity of [NaN, Infinity, -1, 0]) {
    const data = example();
    data.context.capacity = capacity;
    assert.ok(plain(layoutFooter(data, 160)[1].left).startsWith("?/? "));
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
