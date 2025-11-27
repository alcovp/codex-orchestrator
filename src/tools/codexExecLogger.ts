import { spawn } from "node:child_process";
import { appendJobLog, getJobLogPath } from "../jobLogger.js";

const DEFAULT_CAPTURE_LIMIT = 2 * 1024 * 1024;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function shouldTeeOutput(hasJobLog: boolean): boolean {
  const raw = process.env.ORCHESTRATOR_TEE_CODEX;
  // Default: if a job log is present, write there and keep console quiet unless explicitly enabled.
  if (raw === undefined) return hasJobLog ? false : true;
  return isTruthyEnv(raw);
}

function formatTimestamp(date: Date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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
  const jobLogPath = getJobLogPath();
  const hasJobLog = Boolean(jobLogPath);
  const tee = shouldTeeOutput(hasJobLog);
  const prefix = label ? `[${label}]` : `[${command}]`;
  const makeLogLine = (message: string) => `${formatTimestamp()} ${prefix} ${message}`;

  const appendJobLogSafe = (message: string) => {
    if (!hasJobLog) return;
    appendJobLog(makeLogLine(message)).catch(() => {
      /* swallow logging errors */
    });
  };

  if (tee) {
    console.error(makeLogLine(`starting: ${command} ${args.join(" ")} (cwd: ${cwd})`));
  } else {
    appendJobLogSafe(`starting: ${command} ${args.join(" ")} (cwd: ${cwd})`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const lineBuffers: Record<"stdout" | "stderr", string> = {
      stdout: "",
      stderr: "",
    };

    const emitLine = (kind: "stdout" | "stderr", line: string) => {
      const taggedLine = kind === "stderr" ? `[stderr] ${line}` : line;
      if (tee) {
        const target = kind === "stdout" ? process.stdout : process.stderr;
        target.write(`${makeLogLine(taggedLine)}\n`);
      }
      appendJobLogSafe(taggedLine);
    };

    const handleData = (kind: "stdout" | "stderr") => (data: Buffer) => {
      const asString = data.toString("utf8");
      if (kind === "stdout") {
        stdout = appendWithLimit(stdout, asString, captureLimit);
        const combined = lineBuffers.stdout + asString;
        const lines = combined.split(/\r?\n/);
        lineBuffers.stdout = lines.pop() ?? "";
        for (const line of lines) {
          emitLine("stdout", line);
        }
      } else {
        stderr = appendWithLimit(stderr, asString, captureLimit);
        const combined = lineBuffers.stderr + asString;
        const lines = combined.split(/\r?\n/);
        lineBuffers.stderr = lines.pop() ?? "";
        for (const line of lines) {
          emitLine("stderr", line);
        }
      }
    };

    child.stdout?.on("data", handleData("stdout"));
    child.stderr?.on("data", handleData("stderr"));

    child.on("error", (error) => {
      if (lineBuffers.stdout) emitLine("stdout", lineBuffers.stdout);
      if (lineBuffers.stderr) emitLine("stderr", lineBuffers.stderr);
      if (tee) {
        console.error(makeLogLine(`failed to start: ${error?.message ?? String(error)}`));
      } else {
        appendJobLogSafe(`failed to start: ${error?.message ?? String(error)}`);
      }
      (error as any).stdout = stdout;
      (error as any).stderr = stderr;
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (lineBuffers.stdout) emitLine("stdout", lineBuffers.stdout);
      if (lineBuffers.stderr) emitLine("stderr", lineBuffers.stderr);

      if (tee) {
        const suffix = code !== null ? `exit=${code}` : `signal=${signal ?? "unknown"}`;
        console.error(makeLogLine(`finished (${suffix})`));
      } else {
        const suffix = code !== null ? `exit=${code}` : `signal=${signal ?? "unknown"}`;
        appendJobLogSafe(`finished (${suffix})`);
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
