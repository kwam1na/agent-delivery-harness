import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createCheckSnapshot } from "./check-snapshot.ts";

it.skipIf(process.platform === "win32").each(["timeout", "abort"])("bounds stalled setup Git and its descendant before cleanup: %s", async reason => {
  const tools = await mkdtemp(path.join(tmpdir(), "snapshot-setup-tools-"));
  const author = path.join(tools, "author"); await mkdir(author);
  const pidFile = path.join(tools, "pid"), activity = path.join(tools, "activity");
  const descendant = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(activity)},'x'),10)`;
  await writeFile(path.join(tools, "git"), `#!${process.execPath}\nrequire('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)\n`, { mode: 0o755 });
  const controller = new AbortController();
  let settled = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = createCheckSnapshot({ rootDir: author, candidate: { treeSha: "a".repeat(40), headSha: "b".repeat(40), base: { ref: "origin/main", tipSha: "c".repeat(40), mergeBaseSha: "c".repeat(40) } }, outputs: [], environment: { PATH: tools }, signal: controller.signal })
    .then(snapshot => { settled = true; return snapshot.cleanup().then(() => null); }, error => { settled = true; return error; });
  try {
    for (let attempt = 0; attempt < 100; attempt++) { if (await readFile(activity).catch(() => null)) break; await delay(20); }
    expect((await readFile(activity)).length).toBeGreaterThan(0);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(300001); else controller.abort();
    await delay(100);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ code: reason === "timeout" ? "check_snapshot_timeout" : "check_snapshot_interrupted" });
    const before = await readFile(activity, "utf8");
    await delay(100);
    expect(await readFile(activity, "utf8")).toBe(before);
  } finally {
    controller.abort(); await pending; vi.useRealTimers();
    const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid > 1) try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    await rm(tools, { recursive: true, force: true });
  }
}, 10000);
