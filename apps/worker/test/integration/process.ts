import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const workerDir = fileURLToPath(new URL("../..", import.meta.url));

export async function freePort(): Promise<number> {
  const server = createServer().listen(0);
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

export interface WorkerProcess {
  child: ChildProcess;
  port: number;
  logs: Array<Record<string, unknown>>;
  health(path: "/live" | "/ready"): Promise<{ status: number; body: Record<string, unknown> }>;
  waitForLog(
    predicate: (line: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  exited: Promise<number | null>;
}

/** Spawns src/main.ts as a real OS process and collects its JSON log lines. */
export async function startWorker(env: Record<string, string>): Promise<WorkerProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--conditions=source", "--import", "tsx", "src/main.ts"], {
    cwd: workerDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      WORKER_HEALTH_HOST: "127.0.0.1",
      WORKER_HEALTH_PORT: String(port),
      OUTBOX_POLL_INTERVAL_MS: "100",
      OUTBOX_LEASE_MS: "1500",
      ...env,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const logs: Array<Record<string, unknown>> = [];
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        logs.push(JSON.parse(line));
      } catch {
        logs.push({ raw: line });
      }
    }
  });
  const exited = once(child, "exit").then(([code]) => code as number | null);

  const worker: WorkerProcess = {
    child,
    port,
    logs,
    exited,
    async health(path) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    async waitForLog(predicate, timeoutMs = 15_000) {
      await waitFor(() => logs.some(predicate), timeoutMs, "log line");
    },
  };
  await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`worker exited early (${child.exitCode})`);
      try {
        return (await fetch(`http://127.0.0.1:${port}/live`)).ok;
      } catch {
        return false;
      }
    },
    15_000,
    "worker health endpoint",
  );
  return worker;
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function killHard(worker: WorkerProcess) {
  worker.child.kill("SIGKILL");
  await worker.exited;
}
