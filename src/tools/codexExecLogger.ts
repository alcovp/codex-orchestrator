import { spawn } from "node:child_process";

const DEFAULT_CAPTURE_LIMIT = 2 * 1024 * 1024;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function shouldTeeOutput(): boolean {
  const raw = process.env.ORCHESTRATOR_TEE_CODEX;
  // Default: tee is enabled unless explicitly disabled.
  if (raw === undefined) return true;
  return isTruthyEnv(raw);
}

function appendWithLimit(buffer: string, chunk: string, limit: number): string {
  if (limit <= 0) return buffer + chunk;
  const next = buffer + chunk;
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

export interface CodexExecOptions {
  command: string;
  args: string[];
  cwd: string;
  label?: string;
  captureLimit?: number;
}

export async function runWithCodexTee(
  options: CodexExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  const { command, args, cwd, label } = options;
  const captureLimit = options.captureLimit ?? DEFAULT_CAPTURE_LIMIT;
  const tee = shouldTeeOutput();
  const prefix = label ? `[${label}]` : `[${command}]`;

  if (tee) {
    console.error(`${prefix} starting: ${command} ${args.join(" ")} (cwd: ${cwd})`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const handleData = (kind: "stdout" | "stderr") => (data: Buffer) => {
      const asString = data.toString("utf8");
      if (kind === "stdout") {
        stdout = appendWithLimit(stdout, asString, captureLimit);
        if (tee) process.stdout.write(asString);
      } else {
        stderr = appendWithLimit(stderr, asString, captureLimit);
        if (tee) process.stderr.write(asString);
      }
    };

    child.stdout?.on("data", handleData("stdout"));
    child.stderr?.on("data", handleData("stderr"));

    child.on("error", (error) => {
      if (tee) {
        console.error(`${prefix} failed to start: ${error?.message ?? String(error)}`);
      }
      (error as any).stdout = stdout;
      (error as any).stderr = stderr;
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (tee) {
        const suffix = code !== null ? `exit=${code}` : `signal=${signal ?? "unknown"}`;
        console.error(`${prefix} finished (${suffix})`);
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error: any = new Error(
        `"${command}" exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
      );
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

export { DEFAULT_CAPTURE_LIMIT as DEFAULT_CODEX_CAPTURE_LIMIT };
