import { oneLine } from "./run-surface.ts";
import type { RunView, RunViewItem, RunViewSection } from "./run-view.ts";
import type {
  RunArtifactResult,
  RunArtifactMetadata,
} from "@agent-delivery-harness/kernel";
export const escapeViewHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const text = (value: string) => escapeViewHtml(oneLine(value, 8192));
export const OPERATIONAL_STYLE = `
:root{color-scheme:light dark;--paper:#f5f5f7;--surface:#fff;--ink:#1d1d1f;--muted:#626267;--line:#d8d8de;--link:#0067c0;--wash:#eaf2fa}
*{box-sizing:border-box}body{font:400 1rem/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-optical-sizing:auto;letter-spacing:-.01em;color:var(--ink);background:var(--paper);max-width:76rem;margin:0 auto;padding:2.5rem 2rem 5rem;overflow-wrap:anywhere}
h1{font-size:2.25rem;line-height:1.12;letter-spacing:-.04em;margin:0 0 1.25rem;font-weight:700}h2{font-size:1.35rem;line-height:1.3;letter-spacing:-.025em;margin:2rem 0 .5rem}h3{font-size:1.3rem;line-height:1.3;letter-spacing:-.025em;color:var(--ink);margin:0 0 1rem}h4{font-size:1.05rem;line-height:1.35;margin:0 0 1rem;letter-spacing:-.015em}
p{margin:.6rem 0 1rem}.meta,.ended{color:var(--muted);font-size:.875rem}.labels{font-size:.875rem;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:.75rem;padding:1rem 1.25rem;margin:1rem 0}.live{color:var(--ink)}.open{color:var(--muted)}
a{color:var(--link);text-underline-offset:.2em;border-radius:.3rem}a:hover{text-decoration-thickness:2px}a:active,summary:active{background:var(--wash);color:var(--ink)}a:focus-visible,summary:focus-visible{outline:3px solid var(--link);outline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:.4rem;margin:1.5rem 0 2.5rem}nav a{display:inline-flex;align-items:center;min-height:2.75rem;padding:.5rem .85rem;border:1px solid var(--line);border-radius:2rem;background:var(--surface);font-size:.875rem;text-decoration:none}nav a:hover{border-color:var(--link)}
section{scroll-margin-top:1.5rem;margin:2.5rem 0}section>p{color:var(--muted);font-size:.9375rem}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,23rem),1fr));gap:1rem}.card{background:var(--surface);border:1px solid var(--line);border-radius:1rem;padding:1.5rem;min-width:0}.card>a{display:inline-flex;align-items:center;min-height:2.75rem;margin-top:.5rem}dl{margin:.5rem 0}dt{font-size:.8125rem;color:var(--muted);font-weight:500;margin-top:.75rem}dd{margin:.15rem 0 .75rem;overflow-wrap:anywhere}details{margin:1rem 0;border-top:1px solid var(--line);padding-top:.5rem}summary{cursor:pointer;min-height:2.75rem;padding:.5rem 0;font-size:.875rem;color:var(--muted);border-radius:.3rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface);border:1px solid var(--line);border-radius:1rem;padding:1.5rem;font: .875rem/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.table-scroll{max-width:100%;overflow-x:auto;margin:1rem 0 2rem;border:1px solid var(--line);border-radius:.75rem}table{border-collapse:collapse;display:table;min-width:48rem;width:100%;font-size:.8125rem;margin:0}th,td{border:0;border-bottom:1px solid var(--line);padding:.75rem;text-align:left;vertical-align:top}th{background:var(--surface);font-weight:600}tr:last-child td{border-bottom:0}
.back{margin:.5rem 0}.run-identifiers,.view-provenance{margin:.25rem 0;border:0;padding:0}.section-navigation{margin:.25rem 0 1rem;border:0;padding:0}.section-navigation nav{margin:.5rem 0}body>details:first-of-type{margin:.5rem 0;border:0;padding:0}body>h1{margin-bottom:.5rem}section:first-of-type{margin-top:1.25rem}
@media(max-width:600px){body{padding:1.5rem 1rem 3rem;margin:0}h1{font-size:1.875rem}.cards{grid-template-columns:1fr}.card{padding:1.125rem}nav{gap:.375rem}section{margin:2rem 0}}
@media(prefers-color-scheme:dark){:root{--paper:#161618;--surface:#212124;--ink:#f5f5f7;--muted:#b1b1b8;--line:#45454b;--link:#8ac7ff;--wash:#263b50}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
@media(prefers-reduced-transparency:reduce){.card,nav a,.labels{background:var(--surface);backdrop-filter:none}}
@media(prefers-contrast:more){:root{--muted:var(--ink);--line:var(--ink)}a{text-decoration:underline}nav a{border-width:2px}}
body{max-width:68rem;padding-top:2rem}main{min-width:0}.page-header{margin:2rem 0}.page-header h1{margin:.4rem 0 .75rem}.eyebrow{font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;font-weight:600;color:var(--muted);margin:0 0 .5rem}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:1rem;font-size:.8125rem;margin:1rem 0 2rem}.toolbar a{min-height:2.75rem;display:inline-flex;align-items:center}.toolbar .meta{margin-right:auto}.status{display:inline-flex;padding:.3rem .65rem;background:var(--wash);border-radius:2rem;font-size:.8125rem;font-weight:600}.run-list{display:grid;gap:.75rem}.run-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.75rem 2rem;background:var(--surface);border:1px solid var(--line);border-radius:1rem;padding:1.25rem 1.5rem}.run-row h3{font-size:1.125rem;margin:0}.run-row h3 a{display:inline-flex;align-items:center;min-height:2.75rem}.run-row p{margin:.25rem 0}.run-row .run-caption{grid-column:1/-1;font-size:.8125rem;color:var(--muted)}.now-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}.now-grid section{margin:0}.now-grid section h2{margin-top:.5rem}.now-grid .cards{grid-template-columns:1fr}.empty-note{margin:0;padding:1rem 0;font-size:.875rem}.supporting{margin-top:3rem}.supporting>summary{font-size:1rem;font-weight:600;color:var(--ink)}summary span{display:block;font-size:.8125rem;font-weight:400;color:var(--muted);margin:.25rem 0}.section-detail>section{margin-top:.5rem}.card{padding:1.25rem}.card h3{font-size:1rem;margin-bottom:.75rem}.card dl{display:grid;grid-template-columns:7rem minmax(0,1fr);gap:.35rem 1rem;margin:0}.card dt,.card dd{margin:0;font-size:.875rem}.card details{margin-bottom:0}.card details dl{display:block}.card details dt{margin-top:.75rem}.card details dd{margin-top:.2rem}.report-card{border-top:3px solid var(--line)}.report-link{font-weight:500;gap:.5rem}.notice{border-left:3px solid var(--line);padding:.75rem 1rem;background:var(--surface);border-radius:.25rem}.report-page{max-width:54rem}.report-document{background:var(--surface);border:1px solid var(--line);border-radius:1.25rem;padding:2.5rem}.report-document header h2{font-size:1.8rem;margin:.5rem 0 1rem}.report-document p{line-height:1.7;white-space:pre-wrap}.report-document pre{padding:0;border:0}.report-document section{margin:2rem 0}.report-document h3{font-size:1.2rem;line-height:1.4}.finding{border-top:1px solid var(--line);padding:1.75rem 0 .5rem}.finding h4{margin:1.5rem 0 .5rem}.count{font-size:.875rem;font-weight:400;color:var(--muted);margin-left:.5rem}.document-fields>dt{color:var(--ink);font-weight:600;font-size:.875rem;margin-top:1.5rem}.document-fields dd p{margin-top:.25rem}.document-list{padding-left:1.25rem}.document-list li{margin:.75rem 0}.report-tools{margin:1.5rem 0}.report-tools a{display:inline-flex;align-items:center;min-height:2.75rem}
@media(max-width:600px){.now-grid{grid-template-columns:1fr;gap:.5rem}.run-row{padding:1rem;gap:.5rem}.run-row .status{align-self:start}.card dl{grid-template-columns:5.5rem minmax(0,1fr)}.card dt{margin-top:0}.report-document{padding:1.25rem}.page-header{margin:1.5rem 0}.toolbar{gap:.5rem 1rem}}
`;
// Presentation consumes the shared projection; it never decides admission.
const field = (item: RunViewItem, label: string) => item.fields.find(f => f.label === label)?.value;
const friendlyLabels = new Map([
  ["lens.outcome-correctness", "Outcome review"],
  ["lens.adversarial-testing", "Testing review"],
  ["review", "Review report"],
  ["reduction", "Review summary"],
  ["clarification", "Review clarification"],
  ["partial-output", "Partial report"],
]);
const friendly = (value: string) => friendlyLabels.get(value) ?? value;
const primaryLabels: Record<string, readonly string[]> = {
  waiting: ["Owner", "Human action required", "Next action", "Freshness"],
  work: ["Owner", "State", "Freshness", "Next step"],
  reviews: ["Round", "Owner", "State", "Verdict", "Freshness", "Next step"],
  reports: ["Availability", "Reason"],
  finish: ["State", "Owner"],
  findings: ["State", "Severity", "Deferred issue"],
};
function fieldsHtml(fields: RunViewItem["fields"]): string {
  return fields.map(f => `<dt>${text(f.label)}</dt><dd>${text(f.value)}</dd>`).join("");
}
function card(item: RunViewItem, section: string, baseHref: string): string {
  const labels = primaryLabels[section];
  const primary = item.fields.filter(f => labels ? labels.includes(f.label) && f.value !== "Unreported" && !(section === "reports" && f.label === "Availability" && f.value === "referenced") : true);
  const supporting = item.fields.filter(f => !primary.includes(f));
  const title = section === "reports"
    ? friendly(field(item, "Lens") === "Unreported" ? item.label : field(item, "Lens") ?? item.label)
    : section === "work" ? label(field(item, "Phase") ?? "Delivery activity") : friendly(item.label);
  return `<article data-key="${text(item.id)}" class="card ${section === "reports" ? "report-card" : ""}"><h3>${text(title)}</h3><dl>${fieldsHtml(primary)}</dl>${item.artifactId === undefined ? "" : `<a class="report-link" href="${text(baseHref)}/artifacts/${encodeURIComponent(item.artifactId)}">Read report <span aria-hidden="true">↗</span></a>`}${supporting.length ? `<details data-key="support-${text(item.id)}"><summary>Supporting details</summary><dl>${section === "work" ? `<dt>Activity</dt><dd>${text(item.label)}</dd>` : ""}${fieldsHtml(supporting)}</dl></details>` : ""}</article>`;
}
const sectionTitles: Record<string, string> = { waiting: "Needs attention", work: "In progress", reviews: "Reviews", reports: "Review reports", finish: "Delivery milestones" };
const emptyCopy: Record<string, string> = { waiting: "No waits reported.", reviews: "No current reviews reported.", reports: "Review reports will appear here when they are recorded.", finish: "Delivery milestones have not been reported." };
function sectionHtml(section: RunViewSection, baseHref: string): string {
  return `<section id="${text(section.id)}"><h2>${text(sectionTitles[section.id] ?? section.title)}</h2>${section.items.length ? `<div class="cards">${section.items.map(i => card(i, section.id === "earlier-report-list" ? "reports" : section.id, baseHref)).join("")}</div>` : `<p class="empty-note">${text(emptyCopy[section.id] ?? section.empty)}</p>`}</section>`;
}
export function renderOperationalView(view: RunView, baseHref: string): string {
  const sections = new Map(view.sections.map(s => [s.id, s]));
  const render = (id: string) => sections.has(id) ? sectionHtml(sections.get(id)!, baseHref) : "";
  const reviews = sections.get("reviews");
  const work = sections.get("work");
  const currentReviews = reviews?.items.filter(i => i.label !== "Declared review round" && field(i, "History") !== "Superseded attempt") ?? [];
  const reviewIds = new Set(currentReviews.map(i => i.id));
  const reviewCards = currentReviews.map(i => ({ ...i, fields: [...i.fields, ...(work?.items.find(w => w.id === i.id)?.fields.filter(f => ["Freshness", "Next step"].includes(f.label)) ?? [])] }));
  if (work) sections.set("work", { ...work, items: work.items.filter(i => !reviewIds.has(i.id)), empty: work.items.some(i => reviewIds.has(i.id)) ? "Reviews are shown below." : work.empty });
  const reports = sections.get("reports");
  const currentReports = reports?.items.filter(i => field(i, "History") === "Latest observed attempt") ?? [];
  const earlierReports = reports?.items.filter(i => !currentReports.includes(i)) ?? [];
  const pastReviews = reviews?.items.filter(i => !currentReviews.includes(i)) ?? [];
  return `${view.historical ? '<p class="notice">Historical archive · Observations retained at export.</p>' : ""}
    <div class="now-grid">${render("waiting")}${render("work")}</div>
    ${sections.get("findings")?.items.length ? render("findings") : ""}
    ${reviews ? sectionHtml({ ...reviews, items: reviewCards }, baseHref) : ""}
    ${reports ? sectionHtml({ ...reports, items: currentReports }, baseHref) : ""}
    ${earlierReports.length && reports ? `<details id="earlier-reports"><summary>Earlier reports <span>${earlierReports.length} reports from earlier attempts or incomplete references</span></summary>${sectionHtml({ ...reports, id: "earlier-report-list", title: "Earlier reports", items: earlierReports }, baseHref)}</details>` : ""}${render("finish")}
    <details id="supporting-evidence" class="supporting"><summary>Evidence, cost and history<span>Supporting facts and earlier observations</span></summary>
    ${pastReviews.length && reviews ? sectionHtml({ ...reviews, id: "review-history", title: "Earlier reviews and round details", items: pastReviews }, baseHref) : ""}
    ${["evidence", "cost", "activity-history", "finding-history"].map(id => `<details id="details-${id}" class="section-detail"><summary>${text(sections.get(id)?.title ?? id)} <span>${sections.get(id)?.items.length ?? 0} entries</span></summary>${render(id)}</details>`).join("")}
    ${!sections.get("findings")?.items.length ? render("findings") : ""}</details>`;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const label = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase());
// A bounded reading view for arbitrary report schemas. All content remains inert;
// the retained source and download are the authority for exact report bytes.
function documentValue(value: unknown, depth = 0): string {
  if (depth > 4) return '<p class="meta">Further detail is available in the original report.</p>';
  if (Array.isArray(value)) return value.length ? `<ul class="document-list">${value.slice(0, 40).map(v => `<li>${documentValue(v, depth + 1)}</li>`).join("")}</ul>${value.length > 40 ? '<p class="meta">Additional entries are available in the original report.</p>' : ""}` : '<p class="meta">None reported.</p>';
  if (record(value)) return `<dl class="document-fields">${Object.entries(value).slice(0, 40).map(([k,v]) => `<dt>${text(label(k))}</dt><dd>${documentValue(v, depth + 1)}</dd>`).join("")}</dl>${Object.keys(value).length > 40 ? '<p class="meta">Additional fields are available in the original report.</p>' : ""}`;
  return `<p>${text(value === null ? "Not reported" : String(value))}</p>`;
}
function structuredReport(source: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return undefined; }
  if (!record(parsed)) return undefined;
  const result = parsed["outcome"] ?? parsed["verdict"] ?? parsed["decision"];
  const findings = parsed["findings"];
  const headline = result === "aligned" ? "Aligned" : (result === "dissent" || result === "changes-requested" || result === "CHANGES_REQUESTED") ? "Changes requested" : typeof result === "string" ? result : "Report contents";
  const summary = parsed["summary"] ?? parsed["assessment"];
  const rest = Object.fromEntries(Object.entries(parsed).filter(([k]) => !["outcome", "verdict", "decision", "findings", "summary", "assessment"].includes(k)));
  return `<article class="report-document"><header><p class="eyebrow">Reported result</p><h2>${text(headline)}</h2>${summary === undefined ? "" : documentValue(summary)}</header>
    ${Array.isArray(findings) ? `<section><h2>Findings <span class="count">${findings.length}</span></h2>${findings.length === 0 ? '<p>No findings reported in this document.</p>' : findings.slice(0, 40).map((finding, index) => {
      if (!record(finding)) return documentValue(finding);
      const title = typeof finding["title"] === "string" ? finding["title"] : `Finding ${index + 1}`;
      const why = finding["why_it_matters"] ?? finding["description"];
      const fix = finding["suggested_fix"];
      const extra = Object.fromEntries(Object.entries(finding).filter(([k]) => !["title", "severity", "why_it_matters", "description", "suggested_fix"].includes(k)));
      return `<article class="finding"><p class="eyebrow">${text(typeof finding["severity"] === "string" ? finding["severity"] : "Severity unreported")}</p><h3>${text(title)}</h3>${why === undefined ? "" : documentValue(why)}${fix === undefined ? "" : `<h4>Recommended change</h4>${documentValue(fix)}`}<details><summary>Evidence and context</summary>${documentValue(extra)}</details></article>`;
    }).join("")}${findings.length > 40 ? '<p>Additional findings are available in the original report.</p>' : ""}</section>` : findings === undefined ? "" : `<section><h2>Findings</h2>${documentValue(findings)}</section>`}
    <details><summary>Review context and supporting evidence</summary>${documentValue(rest)}</details></article>`;
}
export function renderArtifactDetail(input: {
  runId: string;
  artifactId: string;
  backHref: string;
  result: RunArtifactResult;
  historical: boolean;
  metadata?: RunArtifactMetadata;
}): string {
  const { result } = input;
  const m = result.ok ? result.metadata : input.metadata;
  const source = result.ok ? Buffer.from(result.base64, "base64").toString("utf8") : "";
  const document = result.ok ? structuredReport(source) : undefined;
  const title = friendly(m?.lensId ?? "Review report");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text(title)} · Delivery runs</title><style>${OPERATIONAL_STYLE}</style></head><body class="report-page"><main><a class="back" href="${text(input.backHref)}#reports">Return to run</a><header class="page-header"><p class="eyebrow">${input.historical ? "Historical archive" : "Retained report"}${m?.round === undefined ? "" : ` · Round ${m.round}`}</p><h1>${text(title)}</h1><p class="meta">Reported review output; not approval evidence.</p></header>
    ${result.ok ? `${document ?? `<article class="report-document"><h2>Report contents</h2><pre>${escapeViewHtml(source)}</pre></article>`}<div class="report-tools"><a href="${text(input.backHref)}/artifacts/${encodeURIComponent(input.artifactId)}/download">Download original report</a></div>${document ? `<details><summary>Original report source</summary><pre>${escapeViewHtml(source)}</pre></details>` : ""}` : `<section class="notice" role="status"><h2>Report unavailable</h2><p>${text(result.reason)}</p><p class="meta">${text(result.code)}</p></section>`}
    <details><summary>Report details and provenance</summary><dl><dt>Run</dt><dd>${text(input.runId)}</dd><dt>Artifact</dt><dd>${text(input.artifactId)}</dd>${m ? `<dt>Lens</dt><dd>${text(m.lensId ?? "Unreported")}</dd><dt>Attempt</dt><dd>${text(m.attemptId)}</dd><dt>Candidate</dt><dd>${text(m.candidateTreeSha)}</dd><dt>Digest</dt><dd>${text(m.digest)}</dd><dt>Size</dt><dd>${m.sizeBytes} bytes</dd>` : ""}</dl></details></main></body></html>`;
}
