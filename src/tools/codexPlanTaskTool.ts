import { tool, RunContext } from "@openai/agents";
import { z } from "zod";
import { access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OrchestratorContext } from "../orchestratorTypes.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;
const OUTPUT_TRUNCATE = 2000;

const PlannerParamsSchema = z.object({
  project_root: z.string().describe("Absolute or baseDir-relative path to the repository root."),
  user_task: z.string().describe("High-level user request to plan."),
});

const PlannerSubtaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  parallel_group: z.string(),
  notes: z.string().nullable().optional(),
});

const PlannerOutputSchema = z.object({
  can_parallelize: z.boolean(),
  subtasks: z.array(PlannerSubtaskSchema),
});

export type CodexPlanTaskInput = z.infer<typeof PlannerParamsSchema>;
export type CodexPlanTaskResult = {
  can_parallelize: boolean;
  subtasks: Array<
    z.infer<typeof PlannerSubtaskSchema> & {
      notes: string | null;
    }
  >;
};

type PlannerExec = (args: { cwd: string; prompt: string }) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: PlannerExec = async ({ cwd, prompt }) => {
  return execFileAsync("codex", ["exec", "--full-auto", prompt], {
    cwd,
    maxBuffer: DEFAULT_MAX_BUFFER,
  });
};

let execImplementation: PlannerExec = defaultExec;

export function setPlannerExecImplementation(fn: PlannerExec | null) {
  execImplementation = fn ?? defaultExec;
}

function resolveProjectRoot(projectRoot: string, runContext?: RunContext<OrchestratorContext>): string {
  if (runContext?.context?.repoRoot) {
    return runContext.context.repoRoot;
  }

  if (path.isAbsolute(projectRoot)) {
    return projectRoot;
  }

  const baseDir =
    runContext?.context?.repoRoot ??
    runContext?.context?.baseDir ??
    process.env.ORCHESTRATOR_BASE_DIR ??
    // fallback: current working directory if nothing else is set
    process.cwd();

  return path.resolve(baseDir, projectRoot);
}

async function ensureDirectoryExists(directory: string) {
  try {
    await access(directory);
  } catch {
    throw new Error(`project_root does not exist or is not accessible: ${directory}`);
  }
}

function buildPlannerPrompt(userTask: string): string {
  return [
    "Ты работаешь в этом репозитории. Ничего не изменяй в коде, только анализируй.",
    "",
    "Запрос пользователя:",
    `"${userTask}"`,
    "",
    "Твоя задача:",
    "1. Понять, что нужно сделать в рамках этого проекта.",
    "2. Разбить работу на подзадачи.",
    "3. Определить, какие подзадачи можно выполнять параллельно.",
    "",
    "Формат ответа — ВАЛИДНЫЙ JSON по схеме:",
    "",
    "{",
    '  "can_parallelize": boolean,',
    '  "subtasks": [',
    "    {",
    '      "id": "string",',
    '      "title": "string",',
    '      "description": "string",',
    '      "parallel_group": "string",',
    '      "notes": "string | null"',
    "    }",
    "  ]",
    "}",
    "",
    "Не пиши ничего, кроме JSON.",
  ].join("\n");
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Planner output is empty");
  }

  const direct = tryParseJson(trimmed);
  if (direct !== null) {
    return direct;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");

  if (first === -1 || last === -1 || last <= first) {
    throw new Error("No JSON object boundaries found in planner output");
  }

  const candidate = trimmed.slice(first, last + 1);
  const parsed = tryParseJson(candidate);
  if (parsed !== null) {
    return parsed;
  }

  throw new Error("Unable to parse JSON object from planner output");
}

function normalizeOutput(raw: unknown): CodexPlanTaskResult {
  const parsed = PlannerOutputSchema.parse(raw);
  return {
    can_parallelize: parsed.can_parallelize,
    subtasks: parsed.subtasks.map((subtask) => ({
      ...subtask,
      notes: subtask.notes ?? null,
    })),
  };
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)} ... [truncated ${text.length - limit} chars]`;
}

export async function codexPlanTask(
  params: CodexPlanTaskInput,
  runContext?: RunContext<OrchestratorContext>,
): Promise<CodexPlanTaskResult> {
  const projectRoot = resolveProjectRoot(params.project_root, runContext);
  await ensureDirectoryExists(projectRoot);

  const prompt = buildPlannerPrompt(params.user_task);
  let stdout = "";
  let stderr = "";

  try {
    const result = await execImplementation({ cwd: projectRoot, prompt });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    return normalizeOutput(extractJsonObject(stdout || stderr));
  } catch (error: any) {
    stdout = (error?.stdout ?? stdout ?? "") as string;
    stderr = (error?.stderr ?? stderr ?? error?.message ?? "") as string;

    try {
      return normalizeOutput(extractJsonObject(`${stdout}\n${stderr}`));
    } catch {
      const parts = [
        "codex_plan_task failed: could not parse planner JSON.",
        stdout ? `stdout (truncated):\n${truncate(stdout, OUTPUT_TRUNCATE)}` : null,
        stderr ? `stderr (truncated):\n${truncate(stderr, OUTPUT_TRUNCATE)}` : null,
        error?.message ? `error: ${error.message}` : null,
      ].filter(Boolean);

      throw new Error(parts.join("\n\n"));
    }
  }
}

export const codexPlanTaskTool = tool({
  name: "codex_plan_task",
  description:
    "Call Codex CLI to produce a JSON plan for the user_task without modifying the repository.",
  parameters: PlannerParamsSchema,
  async execute(params, runContext?: RunContext<OrchestratorContext>) {
    return codexPlanTask(params, runContext);
  },
});
