import { tool, RunContext } from "@openai/agents";
import { z } from "zod";
import { access, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { OrchestratorContext } from "../orchestratorTypes.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;
const OUTPUT_TRUNCATE = 2000;

const SubtaskInputSchema = z.object({
  project_root: z.string().describe("Absolute or baseDir-relative path to the repository root."),
  worktree_name: z.string().describe("Name for the worktree under project_root/work3/."),
  base_branch: z
    .string()
    .describe("Base branch/ref for git worktree add (e.g., main, HEAD, origin/main).")
    .default("main"),
  subtask: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    parallel_group: z.string().describe("Parallel group id (string, can be empty)."),
  }),
});

const SubtaskOutputSchema = z.object({
  subtask_id: z.string(),
  status: z.enum(["ok", "failed"]),
  summary: z.string(),
  important_files: z.array(z.string()),
});

export type CodexRunSubtaskInput = z.infer<typeof SubtaskInputSchema>;
export type CodexRunSubtaskResult = z.infer<typeof SubtaskOutputSchema>;

type SubtaskExec = (args: {
  program: "git" | "codex";
  args: string[];
  cwd: string;
}) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: SubtaskExec = async ({ program, args, cwd }) => {
  return execFileAsync(program, args, { cwd, maxBuffer: DEFAULT_MAX_BUFFER });
};

let execImplementation: SubtaskExec = defaultExec;

export function setSubtaskExecImplementation(fn: SubtaskExec | null) {
  execImplementation = fn ?? defaultExec;
}

function resolveProjectRoot(projectRoot: string, runContext?: RunContext<OrchestratorContext>): string {
  if (path.isAbsolute(projectRoot)) return projectRoot;

  const baseDir =
    runContext?.context?.baseDir ??
    process.env.ORCHESTRATOR_BASE_DIR ??
    // fallback: current working directory if nothing else is set
    process.cwd();

  return path.resolve(baseDir, projectRoot);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureProjectRoot(p: string) {
  if (!(await pathExists(p))) {
    throw new Error(`project_root does not exist or is not accessible: ${p}`);
  }
}

async function ensureParentDir(p: string) {
  const parent = path.dirname(p);
  await mkdir(parent, { recursive: true });
}

function sanitizeBranchName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function buildSubtaskPrompt(subtask: CodexRunSubtaskInput["subtask"]): string {
  return [
    `Задача: ${subtask.title}`,
    "",
    "Описание:",
    subtask.description,
    "",
    "Требования:",
    "- Работай строго в контексте текущего репозитория.",
    "- Минимизируй изменения, пиши понятные коммиты.",
    "- В конце сделай краткий summary изменений в виде JSON:",
    "",
    "{",
    `  "subtask_id": "${subtask.id}",`,
    '  "status": "ok" | "failed",',
    '  "summary": "string",',
    '  "important_files": ["path/file1.tsx", "..."]',
    "}",
    "",
    "Верни этот JSON в конце ответа.",
    "Если нужно комментировать код — комментируй, но JSON должен быть последним и валидным.",
  ].join("\n");
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractLastJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Subtask output is empty");
  }

  const direct = tryParseJson(trimmed);
  if (direct !== null) return direct;

  const lastClosing = trimmed.lastIndexOf("}");
  if (lastClosing === -1) {
    throw new Error("No JSON object boundaries found in subtask output");
  }

  for (let start = trimmed.lastIndexOf("{", lastClosing); start !== -1; start = trimmed.lastIndexOf("{", start - 1)) {
    const candidate = trimmed.slice(start, lastClosing + 1);
    const parsed = tryParseJson(candidate);
    if (parsed !== null) return parsed;
  }

  throw new Error("Unable to parse JSON object from subtask output");
}

function normalizeOutput(raw: unknown): CodexRunSubtaskResult {
  const parsed = SubtaskOutputSchema.parse(raw);
  return {
    ...parsed,
    important_files: parsed.important_files ?? [],
  };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)} ... [truncated ${text.length - limit} chars]`;
}

export async function codexRunSubtask(
  params: CodexRunSubtaskInput,
  runContext?: RunContext<OrchestratorContext>,
): Promise<CodexRunSubtaskResult> {
  const projectRoot = resolveProjectRoot(params.project_root, runContext);
  await ensureProjectRoot(projectRoot);

  const worktreeDir = path.resolve(projectRoot, "work3", params.worktree_name);
  await ensureParentDir(worktreeDir);

  const exists = await pathExists(worktreeDir);
  if (!exists) {
    const branchName = sanitizeBranchName(params.worktree_name, `wt-${Date.now()}`);
    await execImplementation({
      program: "git",
      args: ["worktree", "add", "-b", branchName, worktreeDir, params.base_branch ?? "main"],
      cwd: projectRoot,
    });
  }

  const prompt = buildSubtaskPrompt(params.subtask);
  let stdout = "";
  let stderr = "";

  try {
    const result = await execImplementation({
      program: "codex",
      args: ["exec", "--full-auto", prompt],
      cwd: worktreeDir,
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    return normalizeOutput(extractLastJsonObject(stdout || stderr));
  } catch (error: any) {
    stdout = (error?.stdout ?? stdout ?? "") as string;
    stderr = (error?.stderr ?? stderr ?? error?.message ?? "") as string;
    try {
      return normalizeOutput(extractLastJsonObject(`${stdout}\n${stderr}`));
    } catch {
      const parts = [
        "codex_run_subtask failed: could not parse final JSON.",
        stdout ? `stdout (truncated):\n${truncate(stdout, OUTPUT_TRUNCATE)}` : null,
        stderr ? `stderr (truncated):\n${truncate(stderr, OUTPUT_TRUNCATE)}` : null,
        error?.message ? `error: ${error.message}` : null,
      ].filter(Boolean);
      throw new Error(parts.join("\n\n"));
    }
  }
}

export const codexRunSubtaskTool = tool({
  name: "codex_run_subtask",
  description:
    "Create a worktree for a subtask and call Codex CLI to execute it. Returns the subtask JSON summary.",
  parameters: SubtaskInputSchema,
  async execute(params, runContext?: RunContext<OrchestratorContext>) {
    return codexRunSubtask(params, runContext);
  },
});
