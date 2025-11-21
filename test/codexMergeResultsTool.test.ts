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

after(() => {
  setMergeExecImplementation(null);
});

test("codexMergeResults adds merge worktree, resolves paths, and parses stdout JSON", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-"));
  const projectRoot = path.join(baseDir, "repo");
  await mkdir(projectRoot, { recursive: true });

  const mergeWorktree = path.join(projectRoot, "work3", "merge-final");
  const sample: CodexMergeResultsResult = {
    status: "ok",
    notes: "merged",
    touched_files: ["a.txt", "b.txt"],
  };

  const calls: Array<{ program: string; args: string[]; cwd: string }> = [];

  setMergeExecImplementation(async ({ program, args, cwd }) => {
    calls.push({ program, args, cwd });
    if (program === "git") {
      await mkdir(mergeWorktree, { recursive: true }); // simulate worktree creation
      return { stdout: "", stderr: "" };
    }

    return { stdout: JSON.stringify(sample), stderr: "" };
  });

  try {
    const result = await codexMergeResults(
      {
        project_root: "repo",
        base_branch: "main",
        subtasks_results: [
          { subtask_id: "s1", worktree_path: "../task-1", summary: "done" },
          { subtask_id: "s2", worktree_path: path.join(baseDir, "task-2"), summary: "done" },
        ],
      },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, sample);
    assert.equal(calls[0]?.program, "git");
    assert.deepEqual(calls[0]?.args, ["worktree", "add", mergeWorktree, "main"]);
    assert.equal(calls[0]?.cwd, projectRoot);
    assert.equal(calls[1]?.program, "codex");
    assert.equal(calls[1]?.cwd, mergeWorktree);

    const prompt = calls[1]?.args?.join(" ") ?? "";
    assert.match(prompt, /task-1/);
    assert.match(prompt, /task-2/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("codexMergeResults skips git when merge worktree exists and parses stderr JSON on failure", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "codex-merge-err-"));
  const projectRoot = path.join(baseDir, "repo");
  const mergeWorktree = path.join(projectRoot, "work3", "merge-final");
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
      throw new Error("git should not be invoked when merge worktree exists");
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
        subtasks_results: [{ subtask_id: "s1", worktree_path: mergeWorktree, summary: "done" }],
      },
      { context: { baseDir } } as any,
    );

    assert.deepEqual(result, sample);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.program, "codex");
    assert.equal(calls[0]?.cwd, mergeWorktree);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
