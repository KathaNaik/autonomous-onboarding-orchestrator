import pino from "pino";

/** JSON logs to stdout; every line carries service and workerId. */
export function createLogger(level: string, workerId: string) {
  return pino({ level, base: { service: "worker", workerId } });
}
