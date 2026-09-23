// Runs one WorkflowService call in its own OS process, so tests can prove state survives restarts.
// Usage: workflow-cli.ts <create|transition|get> <json-or-id>
import { createDatabase, loadDatabaseConfig } from "@aoo/db";
import { createWorkflowService } from "../../../src/index.js";

const [command, arg = ""] = process.argv.slice(2);
const handle = createDatabase(loadDatabaseConfig().DATABASE_URL);
const service = createWorkflowService(handle.db);

try {
  const result =
    command === "create"
      ? await service.createWorkflow(JSON.parse(arg))
      : command === "transition"
        ? await service.transition(JSON.parse(arg))
        : command === "get"
          ? await service.getWorkflow(arg)
          : undefined;
  if (result === undefined) throw new Error(`unknown command ${command}`);
  process.stdout.write(JSON.stringify({ pid: process.pid, result }));
} finally {
  await handle.close();
}
