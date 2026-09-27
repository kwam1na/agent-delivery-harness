import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createExecPort } from "./exec-port.ts";

it.skipIf(process.platform === "win32").each(["timeout", "abort", "overflow", "stderr-overflow", "leader-exit"])("stops an owned descendant before resolving after %s", async reason => {
  const root = await mkdtemp(path.join(tmpdir(), "exec-supervision-"));
  const pidFile = path.join(root, "pid"), activity = path.join(root, "activity");
  const descendant = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(activity)},'x'),10);setTimeout(()=>process.exit(99),5500)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});${reason.endsWith("overflow") ? `setTimeout(()=>process.${reason === "stderr-overflow" ? "stderr" : "stdout"}.write('x'.repeat(65536)),300);` : ""}${reason === "leader-exit" ? "setTimeout(()=>process.exit(0),300)" : "setInterval(()=>{},1000);setTimeout(()=>process.exit(99),5000)"}`;
  const controller = new AbortController();
  const started = performance.now();
  const pending = createExecPort().run({ command: process.execPath, args: ["-e", parent], timeoutMs: 2000, maxBuffer: reason.endsWith("overflow") ? 1024 : 65536, signal: controller.signal });
  try {
    const deadline = Date.now() + 1500;
    while (await readFile(activity).catch(() => null) === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect((await readFile(activity)).length).toBeGreaterThan(0);
    if (reason === "abort") controller.abort();
    const result = await pending;
    expect(performance.now() - started).toBeLessThan(3500);
    expect(result.errorCode).toBe(reason === "abort" ? "ABORT_ERR" : reason.endsWith("overflow") ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : reason === "timeout" ? "SIGKILL" : undefined);
    if (reason === "leader-exit") expect(result.code).toBe(0); else expect(result.code).not.toBe(0);
    const before = await readFile(activity, "utf8");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await readFile(activity, "utf8")).toBe(before);
  } finally {
    controller.abort();
    await pending;
    const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
    if (pid > 1) try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).errno !== 3) throw error; }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);


it("preserves success, failure, missing-command and bounded output results", async () => {
  const exec = createExecPort();
  expect(await exec.run({ command: process.execPath, args: ["-e", "process.stdout.write('héllo');process.stderr.write('error')"] }))
    .toEqual({ code: 0, stdout: "héllo", stderr: "error" });
  expect(await exec.run({ command: process.execPath, args: ["-e", "process.exit(7)"] })).toMatchObject({ code: 7, errorCode: "7" });
  expect(await exec.run({ command: "missing-exec-supervision-command", args: [] })).toMatchObject({ code: 1, errorCode: "ENOENT" });
  const overflow = await exec.run({ command: process.execPath, args: ["-e", "process.stdout.write('a'.repeat(65536))"], maxBuffer: 128 });
  expect(overflow).toMatchObject({ code: 1, errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  expect(Buffer.byteLength(overflow.stdout)).toBeLessThanOrEqual(128);
});

it("does not launch an already-cancelled invocation", async () => {
  const controller = new AbortController(); controller.abort();
  expect(await createExecPort().run({ command: "missing-exec-supervision-command", args: [], signal: controller.signal })).toMatchObject({ code: 1, errorCode: "ABORT_ERR" });
});


it.skipIf(process.platform === "win32")("supervises actual Bun descendants when Bun is installed", async context => {
  const exec = promisify(execFile);
  try { await exec("bun", ["--version"]); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { context.skip(); return; } throw error; }
  const result = await exec("bun", [fileURLToPath(new URL("./fixtures/exec-port-native.ts", import.meta.url))], { timeout: 15000 });
  expect(result.stdout).toContain("native process supervision passed");
}, 20000);
