import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { after, test } from "node:test";
import {
  codexRunSubtask,
  setSubtaskExecImplementation,
  type CodexRunSubtaskResult,
} from "../src/tools/codexRunSubtaskTool.js";

after(() => {
  setSubtaskExecImplementation(null);
});

test("codexRunSubtask adds a worktree and parses trailing JSON", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-subtask-"));
  const projectRoot = path.join(baseDir, "repo");
  await mkdir(projectRoot, { recursive: true });

  const jobId = "job-test";
  const worktreeName = "wt-alpha";
  const worktreeDir = path.join(projectRoot, ".codex", "jobs", jobId, "worktrees", worktreeName);

  const sample: CodexRunSubtaskResult = {
    subtask_id: "s1",
    status: "ok",
    summary: "done",
    important_files: ["file.txt"],
    branch: `task-${worktreeName}-${jobId}`,
  };

  const calls: Array<{ program: string; args: string[]; cwd: string }> = [];

  setSubtaskExecImplementation(async ({ program, args, cwd }) => {
    calls.push({ program, args, cwd });
    if (program === "git") {
      if (args[0] === "worktree") {
        await mkdir(worktreeDir, { recursive: true }); // simulate git worktree add
      }
      return { stdout: "", stderr: "" };
    }
    return { stdout: `notes\n${JSON.stringify(sample)}`, stderr: "" };
  });

  try {
    const result = await codexRunSubtask(
      {
        project_root: "repo",
        worktree_name: worktreeName,
        job_id: jobId,
        base_branch: "main",
        subtask: { id: "s1", title: "Do it", description: "desc", parallel_group: "g1" },
      },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, sample);
    const worktreeAdd = calls.find((c) => c.program === "git" && c.args[0] === "worktree");
    assert.ok(worktreeAdd);
    assert.deepEqual(worktreeAdd?.args, [
      "worktree",
      "add",
      "-b",
      sample.branch,
      worktreeDir,
      "main",
    ]);
    assert.equal(worktreeAdd?.cwd, projectRoot);
    const codexCall = calls.find((c) => c.program === "codex");
    assert.equal(codexCall?.cwd, worktreeDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("codexRunSubtask skips git when worktree exists and parses stderr JSON on failure", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-subtask-err-"));
  const projectRoot = path.join(baseDir, "repo");
  const worktreeName = "wt-beta";
  const worktreeDir = path.join(projectRoot, ".codex", "jobs", "job-existing", "worktrees", worktreeName);

  await mkdir(worktreeDir, { recursive: true });

  const sample: CodexRunSubtaskResult = {
    subtask_id: "s2",
    status: "failed",
    summary: "boom",
    important_files: [],
    branch: "existing-branch",
  };

  const calls: Array<{ program: string; cwd?: string; args?: string[] }> = [];

  setSubtaskExecImplementation(async ({ program, cwd, args }) => {
    calls.push({ program, cwd, args });

    if (program === "git") {
      if (args?.[0] === "rev-parse" && cwd === worktreeDir) {
        return { stdout: `${sample.branch}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }

    const error: any = new Error("codex failed");
    error.stdout = "ignored";
    error.stderr = `info\n${JSON.stringify({ ...sample, branch: undefined })}`;
    throw error;
  });

  try {
    const result = await codexRunSubtask(
      {
        project_root: projectRoot,
        worktree_name: worktreeName,
        job_id: "job-existing",
        base_branch: "main",
        subtask: { id: "s2", title: "Failing task", description: "desc", parallel_group: "g2" },
      },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, sample);
    assert.ok(calls.some((c) => c.program === "git"));
    const codexCall = calls.find((c) => c.program === "codex");
    assert.equal(codexCall?.cwd, worktreeDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("codexRunSubtask prefers runContext job/base over params", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-subtask-context-"));
  const projectRoot = path.join(baseDir, "repo");
  await mkdir(projectRoot, { recursive: true });

  const jobIdCtx = "job-ctx";
  const baseBranchCtx = "ctx-main";
  const worktreeName = "wt-ctx";
  const expectedBranch = `task-${worktreeName}-${jobIdCtx}`;
  const worktreeDir = path.join(projectRoot, ".codex", "jobs", jobIdCtx, "worktrees", worktreeName);

  const calls: Array<{ program: string; args?: string[]; cwd?: string }> = [];

  setSubtaskExecImplementation(async ({ program, args, cwd }) => {
    calls.push({ program, args, cwd });

    if (program === "git") {
      if (args?.[0] === "worktree") {
        await mkdir(worktreeDir, { recursive: true });
      }
      return { stdout: "", stderr: "" };
    }

    const result: CodexRunSubtaskResult = {
      subtask_id: "ctx",
      status: "ok",
      summary: "ok",
      important_files: [],
      branch: expectedBranch,
    };
    return { stdout: JSON.stringify(result), stderr: "" };
  });

  try {
    const result = await codexRunSubtask(
      {
        project_root: projectRoot,
        worktree_name: worktreeName,
        job_id: "param-job",
        base_branch: "param-main",
        subtask: { id: "ctx", title: "Ctx", description: "desc", parallel_group: null },
      },
      { context: { baseDir, repoRoot: projectRoot, jobId: jobIdCtx, baseBranch: baseBranchCtx } } as any,
    );

    assert.equal(result.branch, expectedBranch);
    const worktreeAdd = calls.find((c) => c.program === "git" && c.args?.[0] === "worktree");
    assert.ok(worktreeAdd, "git worktree add should be called");
    assert.equal(worktreeAdd?.args?.[5], baseBranchCtx);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
