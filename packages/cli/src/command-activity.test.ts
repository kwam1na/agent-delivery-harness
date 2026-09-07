import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { emitCommand } from "./commands/emit.ts";
import { resolveRunSurface } from "./run-surface.ts";
import { projectRunProgress } from "./run-projection.ts";
import { beginCommandObservation } from "./command-activity.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });
async function setup(version = 2) {
 const root = await mkdtemp(path.join(tmpdir(),"command-activity-")); roots.push(root);
 execFileSync("git",["init","-q",root]);
 const start = await emitCommand.run({rootDir:root,args:["run.started","--version",String(version),...(version===2?["--event-id","start"]:[]),"--json",JSON.stringify({host:"codex",workflow:{releaseId:"test",profile:"core"}})],env:{},readStdin:async()=>"",write:()=>{}});
 expect(start.kind).toBe("ok");
 const resolved=await resolveRunSurface(root);if(!resolved.ok)throw Error(resolved.reason);
 const {store,worktreeKey}=resolved.surface;const current=await store.current(worktreeKey);if(!current.ok||!current.runId)throw Error("missing run");
 const runId=current.runId;
 return {root,store,runId,read:async()=>{const r=await store.read(runId);if(!r.ok)throw Error("read");return r.events;}};
}
it.each([0,1,2,130])("correlates actual outcome %i with its started attempt",async(code)=>{
 const s=await setup();const observation=await beginCommandObservation(s.root,"gate");
 await observation.start("a".repeat(40));
 expect((await s.read()).at(-1)?.payload["state"]).toBe("running");
 await observation.finish(code,12);
 const events=await s.read();const activities=events.filter(e=>e.kind==="activity.observed");
 expect(activities.map(e=>e.payload["state"])).toEqual(["running",code===0?"completed":code===130?"interrupted":"failed"]);
 expect(activities[0]?.payload["attemptId"]).toBe(activities[1]?.payload["attemptId"]);
 expect(activities.every(e=>e.actor.role==="cli"&&e.candidateTreeSha==="a".repeat(40))).toBe(true);
 expect(events.at(-1)?.payload["durationMs"]).toBe(12);
});
it("keeps overlapping invocations separate and missing completion stale",async()=>{
 const s=await setup();const a=await beginCommandObservation(s.root,"gate");const b=await beginCommandObservation(s.root,"gate");
 await a.start("a".repeat(40));await b.start("a".repeat(40));await b.finish(0,1);
 const p=projectRunProgress(await s.read(),"2099-01-01T00:00:00Z");
 expect(p.activities).toHaveLength(2);
 expect(p.activities[0]?.attempts[0]).toMatchObject({state:"running",freshness:"stale"});
 expect(p.activities[1]?.attempts[0]?.state).toBe("completed");
});
it("keeps legacy journals completion-only and ignores a broken store",async()=>{
 const s=await setup(1);const o=await beginCommandObservation(s.root,"check");await o.start("a".repeat(40));await o.finish(1,1);
 expect((await s.read()).map(e=>[e.version,e.kind])).toEqual([["run-event/1","run.started"],["run-event/1","command.completed"]]);
 const broken=await beginCommandObservation(s.root,"gate");await rm(s.store.runsDir,{recursive:true,force:true});
 await expect(broken.start("a".repeat(40))).resolves.toBeUndefined();await expect(broken.finish(130,1)).resolves.toBeUndefined();
});

import config from "../../../harness.config.ts";
import { CliInterruption, runCliBoundary, type CommandDescriptor } from "./boundary.ts";
import type { GateDecision } from "@agent-delivery-harness/kernel";

it.each(["success","failure","interrupt"])("observes the executing CLI boundary: %s",async(mode)=>{
 const s=await setup();
 execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","fixture"],{cwd:s.root});
 const descriptor:CommandDescriptor={name:"check",sourceId:"test.command",summary:"fixture",run:async()=>{
   const events=await s.read();expect(events.at(-1)?.payload["state"]).toBe("running");
   if(mode==="interrupt")throw new CliInterruption();
   if(mode==="failure")throw Error("controlled failure");
   return {kind:"ok"};
 }};
 const code=await runCliBoundary(["check","private argument"],[descriptor],{cwd:s.root,env:{SECRET:"private environment"},stdinIsTTY:false,stdoutIsTTY:false,stdout:()=>{},stderr:()=>{},loadConfig:async()=>({...config,baseRef:"HEAD"})});
 expect(code).toBe(mode==="success"?0:mode==="interrupt"?130:1);
 const events=await s.read();
 expect(events.filter(e=>e.kind==="activity.observed").map(e=>e.payload["state"])).toEqual(["running",mode==="success"?"completed":mode==="interrupt"?"interrupted":"failed"]);
 expect(JSON.stringify(events)).not.toContain("private argument");expect(JSON.stringify(events)).not.toContain("private environment");
});
it("observes only an actual native prompt, preserving its scoped result and errors",async()=>{
 const s=await setup();const observation=await beginCommandObservation(s.root,"gate");await observation.start("a".repeat(40));
 const decision={candidate:{treeSha:"a".repeat(40)}} as GateDecision;
 const prompt=observation.prompt(async()=>{
   const p=projectRunProgress(await s.read(),new Date().toISOString());
   expect(p.waits[0]).toMatchObject({current:true,waitingOn:"human"});
   return false;
 });
 await expect(prompt(decision,[])).resolves.toBe(false);
 await observation.finish(1,4);
 const events=await s.read();expect(events.filter(e=>e.kind==="wait.resolved")).toHaveLength(1);
 expect(projectRunProgress(events,new Date().toISOString()).waits[0]?.current).toBe(false);
});
it("keeps the invocation on its original run when the current pointer changes",async()=>{
 const s=await setup();const observation=await beginCommandObservation(s.root,"check");await observation.start("a".repeat(40));
 const resolved=await resolveRunSurface(s.root);if(!resolved.ok)throw Error(resolved.reason);
 await s.store.clearCurrent(resolved.surface.worktreeKey,s.runId);
 await observation.finish(0,4);
 expect((await s.read()).at(-1)?.kind).toBe("command.completed");
});
it("does not change a boundary failure when its run journal disappears",async()=>{
 const s=await setup();execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","fixture"],{cwd:s.root});
 const descriptor:CommandDescriptor={name:"check",sourceId:"test.command",summary:"fixture",run:async()=>{
   await rm(s.store.runsDir,{recursive:true,force:true});throw new CliInterruption();
 }};
 await expect(runCliBoundary(["check"],[descriptor],{cwd:s.root,env:{},stdinIsTTY:false,stdoutIsTTY:false,stdout:()=>{},stderr:()=>{},loadConfig:async()=>({...config,baseRef:"HEAD"})})).resolves.toBe(130);
});
it("preserves native prompt interruption without a reusable permission grant",async()=>{
 const s=await setup();const o=await beginCommandObservation(s.root,"gate");await o.start("a".repeat(40));
 const error=new CliInterruption();
 await expect(o.prompt(async()=>{throw error;})({candidate:{treeSha:"a".repeat(40)}} as GateDecision,[])).rejects.toBe(error);
 await o.finish(130,3);const events=await s.read();
 expect(events.filter(e=>e.kind==="wait.resolved")[0]?.payload["resolution"]).toBe("Native prompt ended without a decision.");
 expect(events.filter(e=>e.kind==="activity.observed").at(-1)?.payload["state"]).toBe("interrupted");
});

it("connects a native CLI prompt to its observed wait without changing the answer",async()=>{
 const s=await setup();
 execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-qm","fixture"],{cwd:s.root});
 const decision={candidate:{treeSha:"a".repeat(40)}} as GateDecision;
 let nativeCalls=0;
 const descriptor:CommandDescriptor={name:"gate",sourceId:"test.command",summary:"fixture",run:async(context)=>{
   expect(context.promptForWaiver).toBeDefined();
   expect(await context.promptForWaiver!(decision,[])).toBe(false);
   return {kind:"ok"};
 }};
 const code=await runCliBoundary(["gate"],[descriptor],{cwd:s.root,env:{},stdinIsTTY:true,stdoutIsTTY:true,stdout:()=>{},stderr:()=>{},loadConfig:async()=>({...config,baseRef:"HEAD"}),promptForWaiver:async(actualDecision,obligations)=>{
   nativeCalls++;
   expect(actualDecision).toBe(decision);expect(obligations).toEqual([]);
   const current=projectRunProgress(await s.read(),new Date().toISOString());
   expect(current.waits).toHaveLength(1);
   expect(current.waits[0]).toMatchObject({current:true,waitingOn:"human",owner:"operator"});
   return false;
 }});
 expect(code).toBe(0);expect(nativeCalls).toBe(1);
 const events=await s.read();const started=events.find(e=>e.kind==="wait.started");const resolved=events.filter(e=>e.kind==="wait.resolved");
 expect(started).toBeDefined();expect(resolved).toHaveLength(1);
 expect(resolved[0]?.payload).toMatchObject({waitId:started!.payload["waitId"],attemptId:started!.payload["attemptId"],candidateTreeSha:started!.payload["candidateTreeSha"],scope:started!.payload["scope"],resolution:"Native prompt declined."});
 expect(projectRunProgress(events,new Date().toISOString()).waits[0]?.current).toBe(false);
});
