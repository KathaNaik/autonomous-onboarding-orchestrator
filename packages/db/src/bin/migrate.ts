import { loadDatabaseConfig } from "../config.js";
import { runMigrations } from "../migrate.js";

const { DATABASE_URL } = loadDatabaseConfig();
await runMigrations(DATABASE_URL);
console.log("migrations applied");
