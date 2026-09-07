import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createArtifactsPort, defineHarnessConfig, runGitCommand } from "@agent-delivery-harness/kernel";
import adopter from "../../../harness.config.ts";
import { runCli, type CliRuntime } from "./index.ts";
import { runAction } from "../../action/src/main.ts";
const exec=promisify(execFile);const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
const provider = `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.kind==='negotiate')console.log(JSON.stringify({kind:'negotiation',outcome:'supported',selectedVersion:'delivery-provider-rails/1',supportedVersions:['delivery-provider-rails/1']}));
 if(m.kind==='request'){fs.appendFileSync('.git/calls',m.requestId+'\\n');fs.writeFileSync('.git/payload',JSON.stringify(m.payload));
 if(fs.existsSync('.git/change'))fs.appendFileSync('source.ts','changed');
 console.log(JSON.stringify({kind:'terminal',version:m.version,requestId:m.requestId,sequence:1,summary:'observed',outcome:fs.existsSync('.git/fail')?'failed':'success'}));}});`;

async function fixture() {
 const dir=await mkdtemp(path.join(tmpdir(),'live-caller-'));dirs.push(dir);
 const git=async(...args:string[])=>(await exec('git',args,{cwd:dir})).stdout.trim();
 await git('init','-q');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
 await writeFile(path.join(dir,'source.ts'),'export const a=1;');await writeFile(path.join(dir,'harness.config.ts'),'export default {};');
 await git('add','.');await git('-c','commit.gpgsign=false','commit','-qm','base');await git('branch','origin/main');
 const config=defineHarnessConfig({...adopter,preparationCommands:[],preparationWiringPaths:['harness.config.ts'],
 providers:[{id:'live.sensor',findingCodes:[],command:[process.execPath,'-e',provider]}],
 obligations:[{...adopter.obligations[0]!,id:'live.current',freshness:'live',providers:['live.sensor'],activation:{kind:'always'},humanWaiverAllowed:false,allowedResolutionKinds:['satisfied_live_fact','not_applicable']}]});
 const artifactDir=path.join(dir,'.git/artifacts');await mkdir(artifactDir);
 const out:string[]=[],err:string[]=[];
 const runtime:CliRuntime={cwd:dir,env:process.env,stdinIsTTY:false,stdoutIsTTY:false,stdout:t=>out.push(t),stderr:t=>err.push(t),loadConfig:async()=>config,artifacts:createArtifactsPort({runRootBase:artifactDir})};
 const cli=async(...args:string[])=>{out.length=err.length=0;return runCli(args,runtime);};
 const base=await git('rev-parse','origin/main');
 const action=async(requestedHead?:string,eventBase=base)=>{const headSha=requestedHead??await git('rev-parse','HEAD');return runAction({workspace:dir,env:{...process.env,GITHUB_EVENT_NAME:'pull_request',GITHUB_EVENT_PATH:'.git/event.json',GITHUB_SHA:'f'.repeat(40)},git:runGitCommand,
 readFile:async()=>JSON.stringify({action:'synchronize',pull_request:{head:{sha:headSha,ref:'feature'},base:{sha:eventBase,ref:'main'}}}),loadConfig:async()=>config,writeSummary:async()=>{},log:()=>{}});};
 return{dir,git,config,runtime,cli,action,out,err};
}
it('records and verifies an actual live provider locally and through the Action; never replays its stored green',async()=>{
 const f=await fixture();expect(await f.cli('prepare')).toBe(0);expect(await f.cli('record'),f.err.join('\n')).toBe(0);
 expect((await readFile(path.join(f.dir,'.git/calls'),'utf8')).trim().split('\n')).toHaveLength(1);
 await f.git('add','.');await f.git('-c','commit.gpgsign=false','commit','-qm','record');
 expect(await f.cli('verify'),f.err.join('\n')).toBe(0);expect((await f.action()).ok).toBe(true);
 expect((await readFile(path.join(f.dir,'.git/calls'),'utf8')).trim().split('\n')).toHaveLength(3);
 await writeFile(path.join(f.dir,'.git/fail'),'fail');
 expect(await runCli(['verify'],{...f.runtime,liveResults:[{providerId:'live.sensor',runId:'cached-green',status:'green',findings:[]}]})).toBe(1);
 expect((await f.action()).ok).toBe(false);
});
it('Action cannot execute a live provider from a different checkout head or dirty workspace',async()=>{
 const f=await fixture();expect(await f.cli('prepare')).toBe(0);expect(await f.cli('record'),f.err.join('\n')).toBe(0);
 await f.git('add','.');await f.git('-c','commit.gpgsign=false','commit','-qm','record');const head=await f.git('rev-parse','HEAD');
 await f.git('-c','commit.gpgsign=false','commit','--allow-empty','-qm','merge-ref');
 const result=await f.action(head);expect(result.ok).toBe(false);expect(result.blockers.map(b=>b.code)).toContain('live_provider_candidate_mismatch');
 expect((await readFile(path.join(f.dir,'.git/calls'),'utf8')).trim().split('\n')).toHaveLength(1);
 await f.git('checkout','--detach',head);await writeFile(path.join(f.dir,'source.ts'),'dirty');expect((await f.action(head)).ok).toBe(false);
});

it('Action requires the event base before executing live provider code',async()=>{
 const f=await fixture();expect(await f.cli('prepare')).toBe(0);expect(await f.cli('record')).toBe(0);
 await f.git('add','.');await f.git('-c','commit.gpgsign=false','commit','-qm','record');
 const result=await f.action(undefined,'f'.repeat(40));expect(result.ok).toBe(false);
 expect(result.blockers.map(b=>b.code)).toContain('live_provider_base_mismatch');
 expect((await readFile(path.join(f.dir,'.git/calls'),'utf8')).trim().split('\n')).toHaveLength(1);
});
