import { appendDecided } from "../src/checkpoint/append-only-file.ts";

const [journalPath, mode, lock, timeout] = process.argv.slice(2);
if (journalPath === undefined) throw new Error("missing journal path");
try {
  const result = await appendDecided({
    journalPath,
    crossProcess: lock === "true",
    crossProcessTimeoutMs: Number(timeout ?? 5000),
    decide: async (read) => {
      const parsed = await read();
      if (!parsed.ok) throw new Error("corrupt journal");
      process.stdout.write("entered\n");
      if (mode === "hold") {
        await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
        process.stdin.pause();
      }
      const sequence = parsed.entries.length + 1;
      return { ok: true, entry: { sequence }, accepted: sequence };
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
