import { execFileSync } from "node:child_process";
import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestCanonical } from "@agent-delivery-harness/kernel";
import { withRetainedRecord } from "./run-view-record.ts";
import { projectRunView } from "./run-view.ts";
it("reads exact retained binding and provider time without claiming fresh verification, including corrupt/missing/foreign/archive cases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-record-"));
  try {
    const candidateBinding = {
      treeSha: "a".repeat(40),
      deliverableDigest: "b".repeat(64),
      identityToken: "test",
      baseRef: "main",
      baseTipSha: "c".repeat(40),
      mergeBaseSha: "d".repeat(40),
      workspaceId: "w",
    };
    const manifest = { recordedAt: "2026-09-01T12:00:00Z" };
    const record = {
      version: "delivery-record/2",
      gateId: "gate",
      identityToken: "test",
      candidateBinding,
      workspaceId: "w",
      manifestDigest: null,
      attestation: { level: "self" },
      claims: [
        {
          obligationId: "checks",
          outcome: "satisfied_evidence",
          evidence: {
            resolution: {
              kind: "evidence",
              providerId: "checks",
              manifestDigest: digestCanonical(manifest),
              portable: { manifest },
            },
          },
        },
      ],
    };
    const seal = (r: typeof record) =>
      JSON.stringify({ ...r, integrityDigest: digestCanonical(r) });
    await writeFile(path.join(root, "record.json"), seal(record));
    const view = projectRunView([], { now: "2026-09-07T00:00:00Z" });
    const fields = async () =>
      (await withRetainedRecord(view, root, "record.json")).sections.find(
        (s) => s.id === "evidence",
      )!.items[0]!.fields;
    expect(await fields()).toContainEqual({
      label: "Candidate",
      value: candidateBinding.treeSha,
    });
    expect(await fields()).toContainEqual({
      label: "Provider-reported recording time · checks",
      value: manifest.recordedAt,
    });
    expect(await fields()).toContainEqual({
      label: "Original verification time",
      value:
        "Unavailable — delivery records do not store a verification timestamp",
    });
    expect(
      (await fields()).find((f) => f.label === "Applicability")!.value,
    ).toMatch(/^Unknown/);
    await writeFile(
      path.join(root, "record.json"),
      seal({
        ...record,
        candidateBinding: { ...candidateBinding, treeSha: "e".repeat(40) },
      }),
    );
    expect(await fields()).toContainEqual({
      label: "Candidate",
      value: "e".repeat(40),
    });
    expect(
      (await fields()).find((f) => f.label === "Applicability")!.value,
    ).toMatch(/^Unknown/);
    const alteredTime = "2099-01-01T00:00:00Z";
    await writeFile(path.join(root, "record.json"), seal({
      ...record,
      claims: record.claims.map((claim) => ({
        ...claim,
        evidence: {
          resolution: {
            ...claim.evidence.resolution,
            portable: { manifest: { recordedAt: alteredTime } },
          },
        },
      })),
    }));
    expect(await fields()).toContainEqual({
      label: "Retained manifest",
      value: "Corrupt — digest does not match; timestamp unavailable",
    });
    expect(JSON.stringify(await fields())).not.toContain(alteredTime);
    const large = {
      ...record,
      claims: record.claims.map((claim) => ({
        ...claim,
        evidence: {
          ...claim.evidence,
          resolution: {
            ...claim.evidence.resolution,
            portable: {
              manifest,
              artifacts: {
                "report.txt": Buffer.alloc(2 * 1024 * 1024).toString("base64"),
              },
            },
          },
        },
      })),
    };
    await writeFile(path.join(root, "record.json"), seal(large));
    expect(JSON.stringify(await fields())).toContain("Recorded for");
    await writeFile(
      path.join(root, "record.json"),
      " ".repeat(16 * 1024 * 1024 + 1),
    );
    expect(JSON.stringify(await fields())).toContain("Unavailable");
    await rm(path.join(root, "record.json"));
    execFileSync("mkfifo", [path.join(root, "record.json")]);
    expect(JSON.stringify(await fields())).toContain("Unavailable");
    await rm(path.join(root, "record.json"));
    await writeFile(
      path.join(root, "record.json"),
      seal(record).replace(candidateBinding.treeSha, "f".repeat(40)),
    );
    expect(JSON.stringify(await fields())).toContain("Corrupt");
    expect(JSON.stringify(await fields())).not.toContain("Recorded for");
    await rm(path.join(root, "record.json"));
    expect(JSON.stringify(await fields())).toContain("missing");
    await symlink("/etc/passwd", path.join(root, "record.json"));
    expect(JSON.stringify(await fields())).toContain("outside_run_root");
    const archived = { ...view, historical: true };
    expect(await withRetainedRecord(archived, root, "record.json")).toBe(
      archived,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
