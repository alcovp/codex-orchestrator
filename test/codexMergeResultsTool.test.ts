import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import {
  codexMergeResults,
  setMergeExecImplementation,
  type CodexMergeResultsResult,
} from "../src/tools/codexMergeResultsTool.js";
import { buildOrchestratorContext } from "../src/orchestratorTypes.js";

after(() => {
  setMergeExecImplementation(null);
});

test("codexMergeResults adds merge worktree, resolves paths, and parses stdout JSON", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-"));
  const projectRoot = path.join(baseDir, "repo");
  await mkdir(projectRoot, { recursive: true });

  const jobId = "job-merge";
  const mergeWorktree = path.join(projectRoot, ".codex", "jobs", jobId, "worktrees", "result");
  const resultBranch = `result-${jobId}`;
  const sample: CodexMergeResultsResult = {
    status: "ok",
    notes: "merged",
    touched_files: ["a.txt", "b.txt"],
  };

  const calls: Array<{ program: string; args: string[]; cwd: string }> = [];

  setMergeExecImplementation(async ({ program, args, cwd }) => {
    calls.push({ program, args, cwd });
    if (program === "git") {
      if (args[0] === "worktree") {
        await mkdir(mergeWorktree, { recursive: true }); // simulate worktree creation
      }
      return { stdout: "", stderr: "" };
    }

    return { stdout: JSON.stringify(sample), stderr: "" };
  });

  try {
    const result = await codexMergeResults(
      {
        project_root: "repo",
        base_branch: "main",
        job_id: jobId,
        result_branch: resultBranch,
        subtasks_results: [
          { subtask_id: "s1", worktree_path: "../task-1", branch: "task-1", summary: "done" },
          { subtask_id: "s2", worktree_path: path.join(baseDir, "task-2"), branch: "task-2", summary: "done" },
        ],
      },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, sample);
    const worktreeAdd = calls.find((c) => c.program === "git" && c.args[0] === "worktree");
    assert.ok(worktreeAdd);
    assert.deepEqual(worktreeAdd?.args, ["worktree", "add", mergeWorktree, resultBranch]);
    assert.equal(worktreeAdd?.cwd, projectRoot);
    const codexCall = calls.find((c) => c.program === "codex");
    assert.equal(codexCall?.cwd, mergeWorktree);

    const prompt = codexCall?.args?.join(" ") ?? "";
    assert.match(prompt, /task-1/);
    assert.match(prompt, /task-2/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("codexMergeResults skips git when merge worktree exists and parses stderr JSON on failure", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-err-"));
  const projectRoot = path.join(baseDir, "repo");
  const mergeWorktree = path.join(projectRoot, ".codex", "jobs", "job-existing", "worktrees", "result");
  const resultBranch = "result-job-existing";
  await mkdir(mergeWorktree, { recursive: true });

  const sample: CodexMergeResultsResult = {
    status: "needs_manual_review",
    notes: "conflicts",
    touched_files: [],
  };

  const calls: Array<{ program: string; cwd: string }> = [];

  setMergeExecImplementation(async ({ program, cwd }) => {
    calls.push({ program, cwd });
    if (program === "git") {
      return { stdout: "", stderr: "" };
    }
    const error: any = new Error("codex failed");
    error.stdout = "noise";
    error.stderr = JSON.stringify(sample);
    throw error;
  });

  try {
    const result = await codexMergeResults(
      {
        project_root: projectRoot,
        job_id: "job-existing",
        result_branch: resultBranch,
        subtasks_results: [{ subtask_id: "s1", worktree_path: mergeWorktree, branch: "task-s1", summary: "done" }],
      },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, sample);
    assert.ok(calls.some((c) => c.program === "git"));
    const codexCall = calls.find((c) => c.program === "codex");
    assert.equal(codexCall?.cwd, mergeWorktree);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("codexMergeResults prefers runContext job/base/result over params", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-context-"));
  const projectRoot = path.join(baseDir, "repo");
  await mkdir(projectRoot, { recursive: true });

  const jobIdCtx = "job-ctx";
  const baseBranchCtx = "ctx-main";
  const context = buildOrchestratorContext({
    repoRoot: projectRoot,
    jobId: jobIdCtx,
    baseBranch: baseBranchCtx,
  });
  const mergeWorktree = context.resultWorktree;
  const expectedResultBranch = context.resultBranch;

  const calls: Array<{ program: string; args?: string[]; cwd?: string; label?: string }> = [];
  const sample: CodexMergeResultsResult = {
    status: "ok",
    notes: "ok",
    touched_files: ["x.txt"],
  };

  setMergeExecImplementation(async ({ program, args, cwd, label }) => {
    calls.push({ program, args, cwd, label });

    if (program === "git") {
      if (args?.[0] === "rev-parse") {
        throw new Error("missing branch");
      }
      if (args?.[0] === "branch") {
        return { stdout: "", stderr: "" };
      }
      if (args?.[0] === "worktree") {
        await mkdir(mergeWorktree, { recursive: true });
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }

    return { stdout: JSON.stringify(sample), stderr: "" };
  });

  try {
    const result = await codexMergeResults(
      {
        project_root: projectRoot,
        job_id: "param-job",
        base_branch: "param-main",
        result_branch: "param-result",
        subtasks_results: [
          { subtask_id: "s1", worktree_path: projectRoot, branch: "b", summary: "done" },
        ],
      },
      { context } as any,
    );

    assert.deepEqual(result, sample);
    const worktreeAdd = calls.find((c) => c.program === "git" && c.args?.[0] === "worktree");
    assert.ok(worktreeAdd);
    assert.equal(worktreeAdd?.args?.[2], mergeWorktree);
    assert.equal(worktreeAdd?.args?.[3], expectedResultBranch);

    const branchCreate = calls.find((c) => c.program === "git" && c.args?.[0] === "branch");
    assert.ok(branchCreate);
    assert.equal(branchCreate?.args?.[1], expectedResultBranch);
    assert.equal(branchCreate?.args?.[2], baseBranchCtx);

    const codexCall = calls.find((c) => c.program === "codex");
    assert.ok(codexCall);
    assert.equal(codexCall?.cwd, mergeWorktree);
    assert.equal(codexCall?.label, `codex-merge:${expectedResultBranch}`);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
