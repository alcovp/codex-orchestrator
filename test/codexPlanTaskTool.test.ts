import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import {
  codexPlanTask,
  setPlannerExecImplementation,
  type CodexPlanTaskResult,
} from "../src/tools/codexPlanTaskTool.js";

after(() => {
  setPlannerExecImplementation(null);
});

test("codexPlanTask resolves baseDir-relative project_root and parses stdout JSON", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-plan-"));
  const projectRoot = path.join(baseDir, "main");
  await mkdir(projectRoot);

  const samplePlan: CodexPlanTaskResult = {
    can_parallelize: true,
    subtasks: [
      {
        id: "plan-1",
        title: "Do thing",
        description: "First step",
        parallel_group: "g1",
        notes: null,
      },
    ],
  };

  const execCalls: Array<{ cwd: string; prompt: string }> = [];
  setPlannerExecImplementation(async ({ cwd, prompt }) => {
    execCalls.push({ cwd, prompt });
    return { stdout: `note\n${JSON.stringify(samplePlan)}`, stderr: "" };
  });

  try {
    const result = await codexPlanTask(
      { project_root: "main", user_task: "Ship the feature" },
      { context: { baseDir } } as any,
    );

    assert.equal(execCalls[0]?.cwd, projectRoot);
    assert.ok(execCalls[0]?.prompt.includes("Ship the feature"));
    assert.ok(
      execCalls[0]?.prompt.includes("Не добавляй отдельные подзадачи"),
      "planner prompt should discourage extra analysis/QA subtasks",
    );
    assert.deepEqual(result, samplePlan);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("codexPlanTask parses JSON from stderr when command fails", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-plan-err-"));
  const projectRoot = path.join(baseDir, "main");
  await mkdir(projectRoot);

  const samplePlan: CodexPlanTaskResult = {
    can_parallelize: false,
    subtasks: [
      {
        id: "s1",
        title: "Fix bug",
        description: "Fix the blocker",
        parallel_group: "serial",
        notes: "must be done first",
      },
    ],
  };

  setPlannerExecImplementation(async () => {
    const error: any = new Error("Codex failed");
    error.stdout = "some noise";
    error.stderr = `extra\n${JSON.stringify(samplePlan)}`;
    throw error;
  });

  try {
    const result = await codexPlanTask(
      { project_root: projectRoot, user_task: "Handle failure" },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, samplePlan);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
