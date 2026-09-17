/**
 * cli/output.ts — shared stdout/stderr helpers for CLI commands
 */

/** Output JSON to stdout */
export function ok(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/** Output error JSON to stderr and exit with given code */
export function fail(message: string, code: string, exitCode: number, extra?: Record<string, unknown>): never {
  process.stderr.write(JSON.stringify({ error: { code, message, ...extra } }, null, 2) + "\n");
  process.exit(exitCode);
}

/** Read all of stdin as a string */
export async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
