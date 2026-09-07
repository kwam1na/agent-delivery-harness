import { oneLine } from "./run-surface.ts";
import type { RunView } from "./run-view.ts";
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
`;
const secondaryLabels = new Set([
  "Candidate",
  "Attempt",
  "Scope",
  "Lifecycle",
  "Origin",
]);
function fieldsHtml(
  fields: RunView["sections"][number]["items"][number]["fields"],
): string {
  return fields
    .map((f) => `<dt>${text(f.label)}</dt><dd>${text(f.value)}</dd>`)
    .join("");
}
function cardFields(
  fields: RunView["sections"][number]["items"][number]["fields"],
): string {
  const primary = fields.filter((f) => !secondaryLabels.has(f.label));
  const provenance = fields.filter((f) => secondaryLabels.has(f.label));
  return `<dl>${fieldsHtml(primary)}</dl>${provenance.length ? `<details><summary>Provenance and identifiers</summary><dl>${fieldsHtml(provenance)}</dl></details>` : ""}`;
}
export function renderOperationalView(view: RunView, baseHref: string): string {
  return (
    `${view.historical ? '<p class="meta">Historical archive — observations retained at export.</p>' : ""}<details class="section-navigation"><summary>Browse reports, evidence and history</summary><nav aria-label="Run sections">${view.sections.map((s) => `<a href="#${text(s.id)}">${text(s.title)}</a>`).join("")}</nav></details>` +
    view.sections
      .map(
        (s) =>
          `<section id="${text(s.id)}"><h3>${text(s.title)}</h3>${s.items.length ? `<div class="cards">${s.items.map((i) => `<article class="card"><h4>${text(i.label)}</h4>${cardFields(i.fields)}${i.artifactId === undefined ? "" : `<a href="${text(baseHref)}/artifacts/${encodeURIComponent(i.artifactId)}">Open retained report</a>`}</article>`).join("")}</div>` : `<p>${text(s.empty)}</p>`}</section>`,
      )
      .join("")
  );
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Retained report</title><style>body{font:16px/1.5 system-ui;margin:1.5rem}${OPERATIONAL_STYLE}</style></head><body><a href="${text(input.backHref)}#reports">Return to run</a><h1>Retained report</h1><p>Run ${text(input.runId)} · Artifact ${text(input.artifactId)}</p><p>Self-attested ${input.historical ? "historical archive" : "retained"} output; not admission evidence.</p>${m ? `<dl><dt>Lens</dt><dd>${text(m.lensId ?? "Unreported")}</dd><dt>Attempt</dt><dd>${text(m.attemptId)}</dd><dt>Candidate</dt><dd>${text(m.candidateTreeSha)}</dd><dt>Digest</dt><dd>${text(m.digest)}</dd><dt>Size</dt><dd>${m.sizeBytes} bytes</dd></dl>` : ""}${result.ok ? `<a href="${text(input.backHref)}/artifacts/${encodeURIComponent(input.artifactId)}/download">Download exact report bytes</a><pre>${escapeViewHtml(Buffer.from(result.base64, "base64").toString("utf8"))}</pre>` : `<p role="status">${text(result.code)}: ${text(result.reason)}</p>`}</body></html>`;
}
