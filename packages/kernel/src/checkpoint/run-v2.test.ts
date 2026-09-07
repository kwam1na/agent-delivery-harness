import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunStore } from "./run-store.ts";
import { validateRunEventInput, type RunEventInput } from "./run-event.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, {recursive:true,force:true}))); });
const tree = "a".repeat(40);
function event(runId: string, eventId: string, state: string): RunEventInput {
 return {version:"run-event/2",eventId,runId,at:"2026-09-07T12:00:00Z",repo:{commonDir:"/tmp/repo"},actor:{role:"executor"},attestation:"self",kind:"activity.observed",candidateTreeSha:tree,payload:{activityId:"review",attemptId:"attempt-1",state,owner:"reviewer",phase:"review",candidateTreeSha:tree,roundId:"round-1",round:1,lensId:"lens.correctness"}} as unknown as RunEventInput;
}
it("admits a bound v2 terminal observation without an invented predecessor", () => { expect(validateRunEventInput(event("run-1","e1","completed")).ok).toBe(true); });
it("deduplicates retries and refuses conflicting ids and terminal restart",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"run-v2-")); dirs.push(dir); const store=createRunStore(dir); const allocation=await store.allocate(); if(!allocation.ok) throw Error("allocation");
 const e=event(allocation.runId,"e1","completed"); expect((await store.append(allocation.runId,e)).ok).toBe(true);
 expect((await store.append(allocation.runId,e)).ok).toBe(true);
 expect((await store.append(allocation.runId,{...e,payload:{...e.payload,owner:"different"}})).ok).toBe(false);
 expect((await store.append(allocation.runId,event(allocation.runId,"e2","running"))).ok).toBe(false);
 const read=await store.read(allocation.runId); expect(read.ok && read.events.length).toBe(1);
});

import { projectRunActivities } from "./run-activity.ts";
import type { RunEvent } from "./run-event.ts";
const durable = (input: RunEventInput, seq: number): RunEvent => ({...input,seq});
const observe = (id: string, state: string, extra: Record<string, unknown> = {}): RunEventInput => {
 const e=event("run-1",id,state); return {...e,payload:{...e.payload,...extra}};
};
it("preserves parallel and superseded attempts; a delayed old completion cannot close the new wait",()=>{
 const first=observe("e1","running");
 const parallel=observe("e2","running",{activityId:"tests",attemptId:"tests-1"});
 const reopened=observe("e3","running",{attemptId:"attempt-2",supersedesAttemptId:"attempt-1"});
 const wait:RunEventInput={...reopened,eventId:"e4",kind:"wait.started",payload:{activityId:"review",attemptId:"attempt-2",candidateTreeSha:tree,waitId:"w2",owner:"executor",waitingOn:"external",reason:"service unavailable",nextAction:"await service",scope:"this attempt"}};
 const delayed=observe("e5","completed");
 const oldReport:RunEventInput={...delayed,eventId:"e6",kind:"report.referenced",payload:{activityId:"review",attemptId:"attempt-1",candidateTreeSha:tree,reportId:"old-report",role:"review",availability:"unavailable",reason:"interrupted"}};
 const oldFinding:RunEventInput={...delayed,eventId:"e7",kind:"finding.observed",payload:{activityId:"review",attemptId:"attempt-1",candidateTreeSha:tree,findingId:"old-finding",reportId:"old-report",state:"unresolved",severity:"P1"}};
 const newFinding:RunEventInput={...oldFinding,eventId:"e8",payload:{...oldFinding.payload,attemptId:"attempt-2",findingId:"new-finding",reportId:"new-report"}};
 const projected=projectRunActivities([first,parallel,reopened,wait,delayed,oldReport,oldFinding,newFinding].map(durable),{now:"2026-09-07T12:01:00Z"});
 expect(projected.reports).toHaveLength(1);
 expect(projected.reports[0]).toMatchObject({current:false,payload:{reportId:"old-report"}});
 expect(projected.findings).toHaveLength(2);
 expect(projected.findings[0]).toMatchObject({current:false,payload:{findingId:"old-finding"}});
 expect(projected.findings[1]).toMatchObject({current:true,payload:{findingId:"new-finding"}});
 expect(projected.activities).toHaveLength(2);
 const review=projected.activities[0]!;
 expect(review.currentAttemptId).toBe("attempt-2");
 expect(review.attempts[0]).toMatchObject({state:"completed",superseded:true,lifecycleIncomplete:true});
 expect(review.attempts[1]).toMatchObject({state:"running",superseded:false});
 expect(projected.waits[0]).toMatchObject({waitId:"w2",current:true});
 expect(projected.activities[1]!.attempts[0]!.state).toBe("running");
});
it("uses injected observation freshness and leaves missing starts and terminal events unknown",()=>{
 const terminal=durable(observe("e1","completed"),1);
 const queued=durable(observe("e2","queued",{activityId:"deploy",attemptId:"deploy-1"}),2);
 const ended:RunEvent={...terminal,seq:3,eventId:"e3",kind:"run.ended",payload:{result:"partial",cost:{coverage:"unreported",reportedBy:"host"}}};
 const p=projectRunActivities([terminal,queued,ended],{now:"2026-09-07T12:10:00Z",freshnessWindowMs:60000});
 expect(p.activities[0]!.attempts[0]).toMatchObject({lifecycleIncomplete:true,freshness:"stale"});
 expect(p.activities[0]!.attempts[0]!.startedAt).toBeUndefined();
 expect(p.activities[1]!.attempts[0]!.state).toBe("queued");
});
it("retains candidate-bound findings as history without claiming applicability",()=>{
 const attempt=durable(observe("e1","completed"),1);
 const finding:RunEvent={...attempt,seq:2,eventId:"e2",kind:"finding.observed",payload:{activityId:"review",attemptId:"attempt-1",candidateTreeSha:tree,findingId:"f1",reportId:"r1",state:"unresolved",severity:"P1"}};
 expect(projectRunActivities([attempt,finding],{now:attempt.at}).findings[0]!.current).toBe(true);
 expect(projectRunActivities([attempt,finding],{now:attempt.at,currentCandidateTreeSha:"b".repeat(40)}).findings[0]!.current).toBe(false);
 expect(projectRunActivities([attempt,finding],{now:attempt.at,currentCandidateTreeSha:tree}).findings[0]!.current).toBe(true);
});
it("keeps v1 new fields closed and requires complete v2 envelope and review identities",()=>{
 const e=observe("e1","running");
 expect(validateRunEventInput({...e,version:"run-event/1"}).ok).toBe(false);
 expect(validateRunEventInput({...e,eventId:undefined}).ok).toBe(false);
 expect(validateRunEventInput({...e,payload:{...e.payload,roundId:undefined}}).ok).toBe(false);
 expect(validateRunEventInput({...e,payload:{...e.payload,authority:"granted"}}).ok).toBe(false);
});
it("refuses writer upgrades in place and resolutions bound to a different wait attempt",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"run-v2-")); dirs.push(dir);const store=createRunStore(dir);const a=await store.allocate();if(!a.ok)throw Error("allocate");
 const first=event(a.runId,"e1","running");expect((await store.append(a.runId,first)).ok).toBe(true);
 const legacy:RunEventInput={version:"run-event/1",runId:a.runId,at:first.at,repo:first.repo,kind:"blocker.recorded",actor:first.actor,attestation:"self",payload:{code:"x",summary:"x"}};
 expect((await store.append(a.runId,legacy)).ok).toBe(false);
 const wait:RunEventInput={...first,eventId:"e2",kind:"wait.started",payload:{activityId:"review",attemptId:"attempt-1",candidateTreeSha:tree,waitId:"w1",owner:"executor",waitingOn:"human",reason:"permission",nextAction:"respond",scope:"this attempt"}};
 expect((await store.append(a.runId,wait)).ok).toBe(true);
 const wrong:RunEventInput={...wait,eventId:"e3",kind:"wait.resolved",payload:{activityId:"review",attemptId:"attempt-2",candidateTreeSha:tree,waitId:"w1",resolution:"acknowledged",scope:"this attempt"}};
 expect((await store.append(a.runId,wrong)).ok).toBe(false);
 expect((await store.append(a.runId,{...wrong,payload:{...wrong.payload,attemptId:"attempt-1"}})).ok).toBe(true);
});

import { appendFile } from "node:fs/promises";
it("rejects a mixed-version journal on disk and retains its bytes",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"run-v2-"));dirs.push(dir);const store=createRunStore(dir);const allocation=await store.allocate();if(!allocation.ok)throw Error("allocate");
 const first=event(allocation.runId,"e1","running");expect((await store.append(allocation.runId,first)).ok).toBe(true);
 const v1={version:"run-event/1",runId:allocation.runId,seq:2,at:first.at,repo:first.repo,actor:first.actor,attestation:"self",kind:"blocker.recorded",payload:{code:"x",summary:"x"}};
 await appendFile(path.join(store.runsDir,`${allocation.runId}.jsonl`),`${JSON.stringify(v1)}\n`);
 const read=await store.read(allocation.runId);expect(read.ok).toBe(false);if(!read.ok)expect(read.rejections[0]!.code).toBe("unsupported_spec");
});
it("retains waits whose attempt starts were not captured",()=>{
 const base=observe("e1","running");const wait:RunEventInput={...base,kind:"wait.started",payload:{activityId:"review",attemptId:"attempt-1",candidateTreeSha:tree,waitId:"w1",owner:"operator",waitingOn:"human",reason:"permission",nextAction:"respond",scope:"this attempt"}};
 const p=projectRunActivities([durable(wait,1)],{now:wait.at});expect(p.activities).toEqual([]);expect(p.waits[0]!.current).toBe(true);
});
it("rejects a reference that changes the reviewer attempt lens and accepts explicit successor attempts",async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),"run-v2-"));dirs.push(dir);const store=createRunStore(dir);const allocation=await store.allocate();if(!allocation.ok)throw Error("allocate");
 const first=event(allocation.runId,"e1","running");expect((await store.append(allocation.runId,first)).ok).toBe(true);
 const report:RunEventInput={...first,eventId:"e2",kind:"report.referenced",payload:{activityId:"review",attemptId:"attempt-1",candidateTreeSha:tree,roundId:"round-1",round:1,lensId:"different",reportId:"report-1",role:"review",availability:"unavailable",reason:"worker interrupted"}};
 expect((await store.append(allocation.runId,report)).ok).toBe(false);
 const next={...first,eventId:"e3",payload:{...first.payload,attemptId:"attempt-2",supersedesAttemptId:"attempt-1"}};
 expect((await store.append(allocation.runId,next)).ok).toBe(true);
 const delayed={...first,eventId:"e4",payload:{...first.payload,state:"completed"}};
 expect((await store.append(allocation.runId,delayed)).ok).toBe(true);
 const read=await store.read(allocation.runId);if(!read.ok)throw Error("read");expect(projectRunActivities(read.events,{now:first.at}).activities[0]!.currentAttemptId).toBe("attempt-2");
});
it("requires report origins, explicit deferred issues, and keeps metadata shapes closed",()=>{
 const base=observe("e1","completed");
 const finding={...base,kind:"finding.observed",payload:{activityId:"review",attemptId:"attempt-1",candidateTreeSha:tree,findingId:"f1",reportId:"r1",state:"deferred",severity:"P2"}};
 expect(validateRunEventInput(finding).ok).toBe(false);
 expect(validateRunEventInput({...finding,payload:{...finding.payload,deferredIssueId:"V26-1999"}}).ok).toBe(true);
 const artifact={...base,kind:"artifact.referenced",payload:{activityId:"review",attemptId:"attempt-1",candidateTreeSha:tree,artifactId:"a1",digest:"a".repeat(64),sizeBytes:42,mediaType:"application/json",producer:"codex"}};
 expect(validateRunEventInput(artifact).ok).toBe(true);
 expect(validateRunEventInput({...artifact,payload:{...artifact.payload,bytes:"secret content"}}).ok).toBe(false);
});
