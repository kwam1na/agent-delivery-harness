import { validateRunEvent } from "@agent-delivery-harness/kernel";
import { buildRunEvent } from "./run-surface.ts";
import { projectRunView } from "./run-view.ts";
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { renderArtifactDetail, renderOperationalView } from "./run-view-html.ts";
import { RUN_LIVE_SCRIPT } from "./run-live.ts";
import { startRunServer } from "./run-server.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function report(source: string, lensId = "lens.adversarial-testing") {
  return renderArtifactDetail({
    runId: "run-a", artifactId: "report-a", backHref: "/runs/repo/run-a", historical: false,
    result: { ok: true, metadata: { activityId: "review", attemptId: "review-1", candidateTreeSha: "a".repeat(40), artifactId: "report-a", digest: createHash("sha256").update(source).digest("hex"), sizeBytes: Buffer.byteLength(source), mediaType: "application/json", producer: "test", lensId }, base64: Buffer.from(source).toString("base64") },
  });
}
it("presents dissent and its recommended change while preserving hostile original text inertly", () => {
  const source = JSON.stringify({ outcome: "changes-requested", findings: [{ title: "A failed attempt disappears", severity: "P1", why_it_matters: "The operator cannot follow the failure.", suggested_fix: "Retain failed attempts.", evidence: ["<script>alert(1)</script>"] }], evidence: { candidate: "a".repeat(40) } });
  const html = report(source);
  expect(html).toContain("<h2>Changes requested</h2>");
  expect(html).toContain("<h4>Recommended change</h4>");
  expect(html).toContain("Retain failed attempts.");
  expect(html).toContain("<summary>Evidence and context</summary>");
  expect(html).toContain("<summary>Original report source</summary>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain('/artifacts/report-a/download');
});
it("does not infer a clean review from absent findings or an unknown report shape", () => {
  expect(report('{"outcome":"aligned"}')).not.toContain("No findings reported");
  expect(report('{"findings":[]}')).toContain("No findings reported in this document");
  const plain = report("<img src=x onerror=alert(1)>\nraw report");
  expect(plain).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(plain).not.toContain("<img");
  const huge = report(JSON.stringify({ findings: Array.from({length: 41}, (_, i) => ({title: `Finding ${i}`})) }));
  expect(huge).toContain("Additional findings are available in the original report");
  expect(huge).toContain('&quot;Finding 40&quot;'); // Original source is never truncated.
});
it("keeps superseded reviews and identifiers behind disclosures with current review first", () => {
  const item = (id: string, history: string) => ({id, label: "lens.adversarial-testing", fields: [{label: "History", value: history}, {label: "Candidate", value: "bound-candidate"}, {label: "Verdict", value: id}]});
  const html = renderOperationalView({spec: "run-view/1", historical: false, asOf: "now", authority: "reported", sections: [{id: "reviews", title: "Reviews", empty: "None", items: [item("old", "Superseded attempt"), item("current", "Latest observed attempt")]}]}, "/run");
  expect(html.indexOf('<dd>current</dd>')).toBeLessThan(html.indexOf('<summary>Evidence, cost and history'));
  expect(html.indexOf('<dd>old</dd>')).toBeGreaterThan(html.indexOf('<summary>Evidence, cost and history'));
  expect(html).toContain('<summary>Supporting details</summary><dl><dt>History');
  expect(html).toContain("bound-candidate");
});
it("authorizes only the exact live script and keeps error and API routes script-free", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-live-policy-"));
  execFileSync("git", ["init", "-q", root]);
  const result = await startRunServer({repos: [root]});
  if (!result.ok) throw Error(result.reason);
  try {
    const response = await fetch(result.server.url);
    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain(`script-src 'sha256-${createHash("sha256").update(RUN_LIVE_SCRIPT).digest("base64")}'`);
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    const page = await response.text();
    expect(page).toContain("No deliveries yet");
    expect(page).not.toContain("<script>");
    expect(page).not.toContain('http-equiv="refresh"');
    for (const route of ["/api/runs", "/missing"]) {
      expect((await fetch(result.server.url + route)).headers.get("content-security-policy")).toContain("script-src 'none'");
    }
  } finally { await result.server.close(); await rm(root, {recursive: true, force: true}); }
});

it("preserves complete multiline original source beyond the preview boundary", () => {
  const source = JSON.stringify({summary: "x".repeat(10000), trailing: "complete source sentinel"}, null, 2) + "\n";
  const html = report(source);
  const expected = source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  expect(html).toContain(`<summary>Original report source</summary><pre>${expected}</pre>`);
  const plain = "first line\n" + "y".repeat(10000) + "\nlast line\n";
  expect(report(plain)).toContain(`<pre>${plain}</pre>`);
});

it.each(["constructor", "toString"])("renders accepted observations and report titles named %s as text", (name) => {
  const event = {...buildRunEvent({runId: "run-test", commonDir: "/repo", kind: "activity.observed", role: "executor", version: "run-event/2", eventId: "activity-1", payload: {activityId: name, attemptId: "attempt-1", candidateTreeSha: "a".repeat(40), owner: "Reviewer", phase: "review", state: "running"}}), seq: 1};
  expect(validateRunEvent(event).ok).toBe(true);
  expect(renderOperationalView(projectRunView([event], {now: event.at}), "/run")).toContain(`<h3>${name}</h3>`);
  expect(report('{"outcome":"aligned"}', name)).toContain(`<h1>${name}</h1>`);
});

it("shows an active review once while retaining its freshness and next step", () => {
  const shared = {id: "attempt", label: "lens.outcome-correctness", fields: [{label: "Owner", value: "Reviewer Alice"}, {label: "History", value: "Latest observed attempt"}]};
  const html = renderOperationalView({spec: "run-view/1", historical: false, asOf: "now", authority: "reported", sections: [
    {id: "work", title: "Current work", empty: "No work", items: [{id: "implementation", label: "Polish the sidebar", fields: [{label: "Owner", value: "Developer Bea"}, {label: "State", value: "running"}, {label: "Next step", value: "Refine sidebar spacing"}]}, {...shared, fields: [...shared.fields, {label: "Freshness", value: "stale"}, {label: "Next step", value: "Read the changed tests"}]}]},
    {id: "reviews", title: "Reviews", empty: "No reviews", items: [shared]},
  ]}, "/run");
  expect(html.match(/data-key="attempt"/g)).toHaveLength(1);
  const workSection = html.slice(html.indexOf('id="work"'), html.indexOf('id="reviews"'));
  expect(workSection).toContain('data-key="implementation"');
  expect(workSection).toContain("Developer Bea");
  expect(workSection).toContain("running");
  expect(workSection).toContain("Refine sidebar spacing");
  expect(workSection).not.toContain('data-key="attempt"');
  expect(html).toContain("<dt>Freshness</dt><dd>stale</dd>");
  expect(html).toContain("Read the changed tests");
});

it("preserves prototype-like custom report titles as strings", () => {
  expect(report('{"outcome":"aligned"}', "__proto__")).toContain("<h1>__proto__</h1>");
});
