import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createDatabase, outboxEvents } from "@aoo/db";
import { createWorkflowService } from "@aoo/orchestrator";
import type { HrisWebhookAcceptedResponse } from "@aoo/shared";
import { eq } from "drizzle-orm";
import { describe, expect, inject, it } from "vitest";
import { TEST_SECRET, offerSignedEvent, signedRequest } from "../helpers.js";

const apiDir = fileURLToPath(new URL("../..", import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer().listen(0);
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

/** Starts the real API entrypoint as its own OS process and waits until it serves /health. */
async function startApi(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--conditions=source", "--import", "tsx", "src/server.ts"],
    {
      cwd: apiDir,
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOG_LEVEL: "warn",
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        DATABASE_URL: inject("databaseUrl"),
        HRIS_WEBHOOK_SECRET: TEST_SECRET,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`api exited early with ${child.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("api did not become healthy");
}

async function stop(child: ChildProcess) {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

async function send(port: number, event: unknown) {
  const req = signedRequest(event);
  const res = await fetch(`http://127.0.0.1:${port}/webhooks/hris`, {
    method: "POST",
    headers: req.headers,
    body: req.body,
  });
  return { status: res.status, body: (await res.json()) as HrisWebhookAcceptedResponse };
}

describe("persistence across API restarts", () => {
  it("keeps the workflow and outbox event, and dedupes redelivery after a restart", async () => {
    const event = offerSignedEvent();
    const port = await freePort();

    const first = await startApi(port);
    const accepted = await send(port, event);
    await stop(first);
    expect(accepted).toMatchObject({
      status: 202,
      body: { workflowCreated: true, duplicate: false },
    });

    const second = await startApi(port);
    try {
      expect(second.pid).not.toBe(first.pid);
      const redelivered = await send(port, event);
      expect(redelivered).toMatchObject({
        status: 202,
        body: { workflowId: accepted.body.workflowId, duplicate: true },
      });
    } finally {
      await stop(second);
    }

    const handle = createDatabase(inject("databaseUrl"));
    try {
      const details = await createWorkflowService(handle.db).getWorkflow(accepted.body.workflowId);
      expect(details?.workflow).toMatchObject({ state: "RECEIVED", version: 1 });
      expect(details?.employee.hrisEmployeeId).toBe(event.employeeId);
      const outbox = await handle.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, accepted.body.workflowId));
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.publishedAt).toBeNull();
    } finally {
      await handle.close();
    }
  });
});
