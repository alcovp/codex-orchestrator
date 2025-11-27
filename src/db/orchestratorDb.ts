import path from "node:path";
import { mkdir } from "node:fs/promises";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import type { OrchestratorContext } from "../orchestratorTypes.js";
import type { CodexPlanTaskResult } from "../tools/codexPlanTaskTool.js";
import type { CodexRunSubtaskInput, CodexRunSubtaskResult } from "../tools/codexRunSubtaskTool.js";
import type { CodexMergeResultsInput, CodexMergeResultsResult } from "../tools/codexMergeResultsTool.js";
import { appendJobLog } from "../jobLogger.js";

type JobStatus = "planning" | "running" | "merging" | "done" | "failed" | "needs_manual_review";
type SubtaskStatus = "pending" | "running" | "completed" | "failed";

interface ArtifactRecord {
  id: string;
  type: "plan" | "subtask_result" | "merge_result" | "merge_input";
  label?: string;
  createdAt: string;
  subtaskId?: string;
  data: unknown;
}

interface SubtaskRecord {
  id: string;
  title: string;
  description?: string;
  parallel_group?: string;
  status: SubtaskStatus;
  worktree?: string;
  branch?: string;
  summary?: string;
  important_files?: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

interface JobRecord {
  jobId: string;
  repoRoot: string;
  baseBranch: string;
  taskDescription: string;
  userTask: string;
  pushResult: boolean;
  status: JobStatus;
  startedAt: string;
  updatedAt: string;
  plan?: CodexPlanTaskResult;
  mergeResult?: CodexMergeResultsResult;
  subtasks: SubtaskRecord[];
  artifacts: ArtifactRecord[];
}

interface DbData {
  jobs: JobRecord[];
}

const DB_FILENAME = "orchestrator-db.json";
const dbCache = new Map<string, Promise<Low<DbData>>>();

const isoNow = () => new Date().toISOString();

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

async function loadDb(repoRoot: string): Promise<Low<DbData>> {
  const existing = dbCache.get(repoRoot);
  if (existing) return existing;

  const created = (async () => {
    const dbPath = path.resolve(repoRoot, DB_FILENAME);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const adapter = new JSONFile<DbData>(dbPath);
    const db = new Low<DbData>(adapter, { jobs: [] });
    await db.read();
    db.data ||= { jobs: [] };
    await db.write();
    return db;
  })();

  dbCache.set(repoRoot, created);
  return created;
}

function upsertJob(db: Low<DbData>, context: OrchestratorContext): JobRecord {
  const data = db.data!;
  let job = data.jobs.find((j) => j.jobId === context.jobId);
  if (!job) {
    job = {
      jobId: context.jobId,
      repoRoot: context.repoRoot,
      baseBranch: context.baseBranch,
      taskDescription: context.taskDescription,
      userTask: context.userTask,
      pushResult: context.pushResult,
      status: "planning",
      startedAt: isoNow(),
      updatedAt: isoNow(),
      subtasks: [],
      artifacts: [],
    };
    data.jobs.push(job);
  } else {
    job.repoRoot = context.repoRoot;
    job.baseBranch = context.baseBranch;
    job.taskDescription = context.taskDescription;
    job.userTask = context.userTask;
    job.pushResult = context.pushResult;
  }
  return job;
}

function ensureSubtask(job: JobRecord, subtask: CodexRunSubtaskInput["subtask"]): SubtaskRecord {
  const now = isoNow();
  const existing = job.subtasks.find((s) => s.id === subtask.id);
  if (existing) {
    existing.title = subtask.title;
    existing.description = subtask.description;
    existing.parallel_group = subtask.parallel_group ?? undefined;
    existing.updatedAt = now;
    return existing;
  }
  const record: SubtaskRecord = {
    id: subtask.id,
    title: subtask.title,
    description: subtask.description,
    parallel_group: subtask.parallel_group ?? undefined,
    status: "pending",
    updatedAt: now,
  };
  job.subtasks.push(record);
  return record;
}

function logDbError(message: string, error: unknown) {
  appendJobLog(`[db] ${message}: ${error instanceof Error ? error.message : String(error)}`).catch(
    () => {},
  );
}

async function writeSafely(db: Low<DbData>) {
  try {
    await db.write();
  } catch (error) {
    logDbError("failed to write orchestrator DB", error);
  }
}

export async function recordPlannerOutput(params: {
  context: OrchestratorContext;
  plan: CodexPlanTaskResult;
  userTask: string;
}) {
  try {
    const db = await loadDb(params.context.repoRoot);
    const job = upsertJob(db, params.context);
    job.status = "planning";
    job.plan = params.plan;
    job.startedAt ||= isoNow();
    job.updatedAt = isoNow();
    for (const subtask of params.plan.subtasks) {
      ensureSubtask(job, subtask);
    }
    job.artifacts.push({
      id: makeId(),
      type: "plan",
      label: "planner-output",
      createdAt: isoNow(),
      data: params.plan,
    });
    await writeSafely(db);
  } catch (error) {
    logDbError("recordPlannerOutput failed", error);
  }
}

export async function recordSubtaskStart(params: {
  context: OrchestratorContext;
  subtask: CodexRunSubtaskInput["subtask"];
  worktreePath: string;
  branchName: string;
}) {
  try {
    const db = await loadDb(params.context.repoRoot);
    const job = upsertJob(db, params.context);
    job.status = "running";
    const record = ensureSubtask(job, params.subtask);
    const now = isoNow();
    record.status = "running";
    record.worktree = params.worktreePath;
    record.branch = params.branchName;
    record.startedAt = record.startedAt ?? now;
    record.updatedAt = now;
    job.updatedAt = now;
    await writeSafely(db);
  } catch (error) {
    logDbError("recordSubtaskStart failed", error);
  }
}

export async function recordSubtaskResult(params: {
  context: OrchestratorContext;
  subtask: CodexRunSubtaskInput["subtask"];
  worktreePath: string;
  branchName: string;
  result: CodexRunSubtaskResult;
  errorMessage?: string;
}) {
  try {
    const db = await loadDb(params.context.repoRoot);
    const job = upsertJob(db, params.context);
    const record = ensureSubtask(job, params.subtask);
    const now = isoNow();
    const isOk = params.result.status === "ok";
    job.status = isOk ? job.status || "running" : "failed";
    record.status = isOk ? "completed" : "failed";
    record.worktree = params.worktreePath;
    record.branch = params.result.branch ?? params.branchName;
    record.summary = params.result.summary;
    record.important_files = params.result.important_files;
    record.finishedAt = now;
    record.updatedAt = now;
    record.error = params.errorMessage ?? record.error;
    job.updatedAt = now;
    job.artifacts.push({
      id: makeId(),
      type: "subtask_result",
      label: `subtask-${params.subtask.id}`,
      subtaskId: params.subtask.id,
      createdAt: now,
      data: params.result,
    });
    await writeSafely(db);
  } catch (error) {
    logDbError("recordSubtaskResult failed", error);
  }
}

export async function recordMergeStart(params: {
  context: OrchestratorContext;
  mergeInput: CodexMergeResultsInput;
}) {
  try {
    const db = await loadDb(params.context.repoRoot);
    const job = upsertJob(db, params.context);
    const now = isoNow();
    job.status = "merging";
    job.updatedAt = now;
    job.artifacts.push({
      id: makeId(),
      type: "merge_input",
      label: "merge-input",
      createdAt: now,
      data: params.mergeInput,
    });
    await writeSafely(db);
  } catch (error) {
    logDbError("recordMergeStart failed", error);
  }
}

export async function recordMergeResult(params: {
  context: OrchestratorContext;
  mergeResult: CodexMergeResultsResult;
}) {
  try {
    const db = await loadDb(params.context.repoRoot);
    const job = upsertJob(db, params.context);
    const now = isoNow();
    job.status =
      params.mergeResult.status === "needs_manual_review" ? "needs_manual_review" : "done";
    job.mergeResult = params.mergeResult;
    job.updatedAt = now;
    job.artifacts.push({
      id: makeId(),
      type: "merge_result",
      label: "merge-result",
      createdAt: now,
      data: params.mergeResult,
    });
    await writeSafely(db);
  } catch (error) {
    logDbError("recordMergeResult failed", error);
  }
}
