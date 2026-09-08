import { expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { RUN_LIVE_SCRIPT } from "./run-live.ts";

// A minimal page boundary for deterministic polling races. Layout, focus and
// disclosure reconciliation are additionally exercised in the in-app browser.
// The actual shipped script runs unchanged; only browser I/O and time are supplied.
function page(live: boolean, state: string) {
  const values = new Map([["data-live", String(live)], ["data-state", state], ["data-poll-seconds", "1"]]);
  const dataset = {live: String(live), state, pollSeconds: "1"};
  return {
    nodeType: 1, nodeName: "MAIN", dataset, childNodes: [], firstChild: null,
    get attributes() { return [...values].map(([name, value]) => ({name, value})); },
    hasAttribute: (name: string) => values.has(name),
    removeAttribute: (name: string) => { values.delete(name); },
    setAttribute: (name: string, value: string) => { values.set(name, value); if (name === "data-live") dataset.live = value; if (name === "data-state") dataset.state = value; },
    querySelectorAll: () => [],
  };
}
function browser() {
  const root = page(true, "before");
  const status = {textContent: "Live"};
  let click = (_event: {preventDefault(): void}) => {};
  const toggle = {textContent: "Pause updates", hidden: false, addEventListener: (_name: string, fn: typeof click) => { click = fn; }};
  const listeners = new Map<string, () => void>();
  const body = {};
  const document = {body, activeElement: body, hidden: false, querySelector: (selector: string) => selector === "main" ? root : selector === "[data-live-toggle]" ? toggle : status, addEventListener: (event: string, fn: () => void) => listeners.set(event, fn)};
  const timers: (() => Promise<void>)[] = [];
  let now = 10000;
  const fetch = vi.fn<() => Promise<{ok: boolean; text(): Promise<string>}>>();
  const window = {innerHeight: 800, scrollY: 120, getSelection: () => ({isCollapsed: true}), scrollTo: vi.fn(), scrollBy: vi.fn(), addEventListener: vi.fn()};
  runInNewContext(RUN_LIVE_SCRIPT, {
    document, window, fetch, location: {pathname: "/runs/repository/run-test"}, Date: {now: () => now},
    setTimeout: (fn: () => Promise<void>, delay: number) => { expect(delay).toBe(1000); timers.push(fn); return timers.length; }, clearTimeout: vi.fn(), AbortSignal: {timeout: () => undefined},
    DOMParser: class { parseFromString(source: string) { const parsed = JSON.parse(source); const next = page(parsed.live, parsed.state); return {querySelector: () => next}; } },
  });
  return {root, status, toggle, fetch, document, timers,
    click: () => click({preventDefault() {}}),
    interact: () => listeners.get("keydown")!(),
    tick: () => { now += 2000; const timer = timers.shift(); if (!timer) throw Error("No scheduled poll"); return timer(); },
  };
}
const response = (live: boolean, state: string) => ({ok: true, text: async () => JSON.stringify({live, state})});
it.each(["pause", "interaction", "hidden"])("holds an in-flight update after %s, then applies a later update", async (condition) => {
  const b = browser();
  let release!: (value: ReturnType<typeof response>) => void;
  b.fetch.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const pending = b.tick();
  expect(b.fetch).toHaveBeenCalledTimes(1);
  expect(b.timers).toHaveLength(0); // No overlapping poll while the request waits.
  if (condition === "pause") b.click();
  else if (condition === "interaction") b.interact();
  else b.document.hidden = true;
  release(response(true, "arrived-during-reading"));
  await pending;
  expect(b.root.dataset.state).toBe("before");
  if (condition === "pause") { expect(b.status.textContent).toBe("Updates paused"); b.click(); }
  b.document.hidden = false;
  b.fetch.mockResolvedValueOnce(response(true, "after-resume"));
  await b.tick();
  expect(b.fetch).toHaveBeenCalledTimes(2);
  expect(b.root.dataset.state).toBe("after-resume");
  expect(b.status.textContent).toBe("Live");
});
it("applies the terminal page and schedules no further requests", async () => {
  const b = browser();
  b.fetch.mockResolvedValueOnce(response(false, "completed"));
  await b.tick();
  expect(b.root.dataset.state).toBe("completed");
  expect(b.root.dataset.live).toBe("false");
  expect(b.status.textContent).toBe("Saved observations");
  expect(b.toggle.hidden).toBe(true);
  expect(b.timers).toHaveLength(0);
  expect(b.fetch).toHaveBeenCalledTimes(1);
});
it("retains the page on a failed request and recovers on the next poll", async () => {
  const b = browser();
  b.fetch.mockRejectedValueOnce(Error("unavailable"));
  await b.tick();
  expect(b.root.dataset.state).toBe("before");
  expect(b.status.textContent).toBe("Update unavailable · Retrying");
  b.fetch.mockResolvedValueOnce(response(true, "recovered"));
  await b.tick();
  expect(b.root.dataset.state).toBe("recovered");
});
