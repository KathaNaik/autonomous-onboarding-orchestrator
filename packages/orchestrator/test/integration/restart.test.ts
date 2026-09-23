import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, inject, it } from "vitest";
import { newEmployee } from "./helpers.js";

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("./fixtures/workflow-cli.ts", import.meta.url));

/** Runs one service call in a fresh Node process (new pool, no shared memory). */
async function inNewProcess(command: string, arg: unknown) {
  const { stdout } = await run(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      cli,
      command,
      typeof arg === "string" ? arg : JSON.stringify(arg),
    ],
    { cwd: packageDir, env: { ...process.env, DATABASE_URL: inject("databaseUrl") } },
  );
  return JSON.parse(stdout) as { pid: number; result: any };
}

describe("persistence across process restarts", () => {
  it("resumes a workflow created and advanced by processes that have since exited", async () => {
    const created = await inNewProcess("create", { employee: newEmployee(), actor: "proc-1" });
    const id: string = created.result.id;

    const advanced = await inNewProcess("transition", {
      workflowId: id,
      to: "ACCESS_PLANNING",
      expectedVersion: 1,
      actor: "proc-2",
    });
    expect(advanced.pid).not.toBe(created.pid);

    const reloaded = await inNewProcess("get", id);
    expect(reloaded.pid).not.toBe(advanced.pid);
    expect(reloaded.result.workflow).toMatchObject({ id, state: "ACCESS_PLANNING", version: 2 });
    expect(
      reloaded.result.steps.map((s: { stepKey: string; status: string }) => [s.stepKey, s.status]),
    ).toEqual([
      ["RECEIVED", "SUCCEEDED"],
      ["ACCESS_PLANNING", "RUNNING"],
    ]);

    // A later process continues from the persisted version, and stale versions still conflict.
    const resumed = await inNewProcess("transition", {
      workflowId: id,
      to: "POLICY_REVIEW",
      expectedVersion: 2,
      actor: "proc-4",
    });
    expect(resumed.result).toMatchObject({ state: "POLICY_REVIEW", version: 3 });
    await expect(
      inNewProcess("transition", {
        workflowId: id,
        to: "PROVISIONING",
        expectedVersion: 2,
        actor: "proc-5",
      }),
    ).rejects.toThrow(/version conflict/);
  });
});
