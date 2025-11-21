import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import { runDeterministicOrchestrator } from "../src/deterministicOrchestrator.js";
import {
  setPlannerExecImplementation,
  type CodexPlanTaskResult,
} from "../src/tools/codexPlanTaskTool.js";
import {
  setSubtaskExecImplementation,
  type CodexRunSubtaskResult,
} from "../src/tools/codexRunSubtaskTool.js";
import {
  setMergeExecImplementation,
  type CodexMergeResultsResult,
} from "../src/tools/codexMergeResultsTool.js";

after(() => {
  setPlannerExecImplementation(null);
  setSubtaskExecImplementation(null);
  setMergeExecImplementation(null);
});

test("deterministic orchestrator runs plan -> grouped subtasks -> merge", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "orchestrator-deterministic-"));
  const mainDir = path.join(baseDir, "main");
  await mkdir(mainDir, { recursive: true });

  const plan: CodexPlanTaskResult = {
    can_parallelize: true,
    subtasks: [
      { id: "alpha", title: "A", description: "do A", parallel_group: "g1", notes: null },
      { id: "beta", title: "B", description: "do B", parallel_group: "g1", notes: null },
      { id: "gamma", title: "C", description: "do C", parallel_group: "g2", notes: null },
    ],
  };

  const subtaskEvents: string[] = [];
  let completedG1 = 0;

  setPlannerExecImplementation(async () => {
    return { stdout: JSON.stringify(plan), stderr: "" };
  });

  setSubtaskExecImplementation(async ({ program, args, cwd }) => {
    if (program === "git") {
      subtaskEvents.push(`git:${args[2]}`);
      return { stdout: "", stderr: "" };
    }

    const prompt = args[2] ?? "";
    const match = prompt.match(/"subtask_id": "([^"]+)"/);
    const id = match?.[1] ?? "unknown";
    subtaskEvents.push(`codex:${id}:${cwd}`);

    if (id === "gamma") {
      assert.ok(completedG1 >= 2, "gamma started before g1 batch completed");
    }

    const result: CodexRunSubtaskResult = {
      subtask_id: id,
      status: "ok",
      summary: `done-${id}`,
      important_files: [`${id}.txt`],
    };

    if (id === "alpha" || id === "beta") {
      completedG1 += 1;
    }

    return { stdout: JSON.stringify(result), stderr: "" };
  });

  const mergeCalls: Array<{ args: string[]; cwd: string }> = [];
  setMergeExecImplementation(async ({ program, args, cwd }) => {
    if (program === "git") {
      await mkdir(path.join(mainDir, "work3", "merge-final"), { recursive: true });
      return { stdout: "", stderr: "" };
    }
    mergeCalls.push({ args, cwd });
    const result: CodexMergeResultsResult = {
      status: "ok",
      notes: "merged",
      touched_files: ["alpha.txt", "beta.txt", "gamma.txt"],
    };
    return { stdout: JSON.stringify(result), stderr: "" };
  });

  try {
    const result = await runDeterministicOrchestrator({
      userTask: "Ship feature",
      baseDir,
    });

    // Plan captured
    assert.equal(result.plan.subtasks.length, 3);

    // Subtasks run in batches: g1 (alpha/beta) then g2 (gamma)
    assert.ok(completedG1 === 2, "both g1 subtasks should complete");

    // Merge invoked once with merge worktree cwd
    assert.equal(mergeCalls.length, 1);
    assert.ok(mergeCalls[0].cwd.endsWith(path.join("work3", "merge-final")));
    assert.equal(mergeCalls[0].args[0], "exec");
    assert.equal(mergeCalls[0].args[1], "--full-auto");

    // Final merge result surfaced
    assert.equal(result.mergeResult.status, "ok");
    assert.equal(result.subtaskResults.length, 3);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
