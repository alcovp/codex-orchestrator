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

  const worktreeName = "wt-alpha";
  const worktreeDir = path.join(projectRoot, "work3", worktreeName);

  const sample: CodexRunSubtaskResult = {
    subtask_id: "s1",
    status: "ok",
    summary: "done",
    important_files: ["file.txt"],
  };

  const calls: Array<{ program: string; args: string[]; cwd: string }> = [];

  setSubtaskExecImplementation(async ({ program, args, cwd }) => {
    calls.push({ program, args, cwd });
    if (program === "git") {
      await mkdir(worktreeDir, { recursive: true }); // simulate git worktree add
      return { stdout: "", stderr: "" };
    }
    return { stdout: `notes\n${JSON.stringify(sample)}`, stderr: "" };
  });

  try {
    const result = await codexRunSubtask(
      {
        project_root: "repo",
        worktree_name: worktreeName,
        base_branch: "main",
        subtask: { id: "s1", title: "Do it", description: "desc", parallel_group: "g1" },
      },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, sample);
    assert.equal(calls[0]?.program, "git");
    assert.deepEqual(calls[0]?.args, ["worktree", "add", "-b", "wt-alpha", worktreeDir, "main"]);
    assert.equal(calls[0]?.cwd, projectRoot);
    assert.equal(calls[1]?.program, "codex");
    assert.equal(calls[1]?.cwd, worktreeDir);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("codexRunSubtask skips git when worktree exists and parses stderr JSON on failure", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-subtask-err-"));
  const projectRoot = path.join(baseDir, "repo");
  const worktreeName = "wt-beta";
  const worktreeDir = path.join(projectRoot, "work3", worktreeName);

  await mkdir(worktreeDir, { recursive: true });

  const sample: CodexRunSubtaskResult = {
    subtask_id: "s2",
    status: "failed",
    summary: "boom",
    important_files: [],
  };

  const calls: Array<{ program: string }> = [];

  setSubtaskExecImplementation(async ({ program, cwd }) => {
    calls.push({ program });
    assert.equal(cwd, worktreeDir);

    if (program === "git") {
      throw new Error("git should not be invoked when worktree already exists");
    }

    const error: any = new Error("codex failed");
    error.stdout = "ignored";
    error.stderr = `info\n${JSON.stringify(sample)}`;
    throw error;
  });

  try {
    const result = await codexRunSubtask(
      {
        project_root: projectRoot,
        worktree_name: worktreeName,
        base_branch: "main",
        subtask: { id: "s2", title: "Failing task", description: "desc", parallel_group: "g2" },
      },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, sample);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.program, "codex");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
