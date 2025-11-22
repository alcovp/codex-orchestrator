import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithCodexTee } from "../src/tools/codexExecLogger.js";

function restoreEnv(prev: string | undefined) {
  if (prev === undefined) {
    delete process.env.ORCHESTRATOR_TEE_CODEX;
  } else {
    process.env.ORCHESTRATOR_TEE_CODEX = prev;
  }
}

test("runWithCodexTee tees stdout/stderr while capturing output", async () => {
  const prevTee = process.env.ORCHESTRATOR_TEE_CODEX;
  process.env.ORCHESTRATOR_TEE_CODEX = "1";

  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const seen: string[] = [];

  (process.stdout as any).write = ((chunk: any, encoding?: any, cb?: any) => {
    seen.push(`out:${chunk.toString()}`);
    if (typeof encoding === "function") encoding();
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stdout.write;

  (process.stderr as any).write = ((chunk: any, encoding?: any, cb?: any) => {
    seen.push(`err:${chunk.toString()}`);
    if (typeof encoding === "function") encoding();
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;

  try {
    const { stdout, stderr } = await runWithCodexTee({
      command: process.execPath,
      args: ["-e", "console.log('hello'); console.error('oops');"],
      cwd: process.cwd(),
      label: "tee-test",
    });

    assert.ok(stdout.includes("hello"), "stdout should contain command output");
    assert.ok(stderr.includes("oops"), "stderr should contain command output");
    assert.ok(seen.some((line) => line.includes("hello")), "tee should hit stdout write");
    assert.ok(seen.some((line) => line.includes("oops")), "tee should hit stderr write");
  } finally {
    restoreEnv(prevTee);
    (process.stdout as any).write = originalStdout;
    (process.stderr as any).write = originalStderr;
  }
});

test("runWithCodexTee keeps tail within captureLimit", async () => {
  const prevTee = process.env.ORCHESTRATOR_TEE_CODEX;
  process.env.ORCHESTRATOR_TEE_CODEX = "0"; // keep test output quiet

  try {
    const captureLimit = 50;
    const { stdout, stderr } = await runWithCodexTee({
      command: process.execPath,
      args: [
        "-e",
        "const long = 'a'.repeat(2000); console.log(long); console.log('tail-marker');",
      ],
      cwd: process.cwd(),
      label: "limit-test",
      captureLimit,
    });

    assert.equal(stderr.trim(), "");
    assert.ok(stdout.includes("tail-marker"), "tail should survive truncation");
    assert.ok(stdout.length <= captureLimit, "captured stdout should respect limit");
  } finally {
    restoreEnv(prevTee);
  }
});

test("runWithCodexTee surfaces stderr on non-zero exit", async () => {
  const prevTee = process.env.ORCHESTRATOR_TEE_CODEX;
  process.env.ORCHESTRATOR_TEE_CODEX = "0";

  try {
    await assert.rejects(
      runWithCodexTee({
        command: process.execPath,
        args: ["-e", "console.error('fail'); process.exit(2);"],
        cwd: process.cwd(),
        label: "failure-test",
      }),
      (error: any) => {
        assert.equal(error.code, 2);
        assert.ok(String(error.stderr).includes("fail"));
        return true;
      },
    );
  } finally {
    restoreEnv(prevTee);
  }
});
