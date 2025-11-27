import assert from "node:assert/strict"
import { test } from "node:test"
import {
    type EnqueuedTask,
    type TaskReporter,
    type TaskSource,
    runTaskDispatcher,
    createInMemoryTaskSource,
} from "../src/taskDispatcher.js"

test("runTaskDispatcher processes tasks sequentially and stops when empty", async () => {
    const tasks: EnqueuedTask[] = [
        { id: "1", description: "Task 1", source: "memory" },
        { id: "2", description: "Task 2", source: "memory" },
    ]

    const calls: string[] = []
    const events: string[] = []

    const reporter: TaskReporter = {
        onStart: (task) => events.push(`start:${task.id}`),
        onSuccess: (task) => events.push(`success:${task.id}`),
    }

    await runTaskDispatcher({
        sources: [createInMemoryTaskSource("memory", tasks)],
        baseDir: "/tmp/fake",
        stopWhenEmpty: true,
        runOrchestratorFn: async (options) => {
            calls.push(`${options.taskDescription}:${options.baseDir}`)
            return `done:${options.taskDescription}`
        },
        reporter,
    })

    assert.deepEqual(calls, ["Task 1:/tmp/fake", "Task 2:/tmp/fake"])
    assert.deepEqual(events, ["start:1", "success:1", "start:2", "success:2"])
})

test("runTaskDispatcher triggers failure hooks and continues loop", async () => {
    const task: EnqueuedTask = { id: "f1", description: "Fail once", source: "memory" }
    let served = false
    const marks: string[] = []
    const events: string[] = []

    const source: TaskSource = {
        name: "single",
        async nextTask() {
            if (served) return null
            served = true
            return task
        },
        async markFailed(t) {
            marks.push(`failed:${t.id}`)
        },
    }

    const reporter: TaskReporter = {
        onStart: (t) => events.push(`start:${t.id}`),
        onFailure: (t) => events.push(`failure:${t.id}`),
        onIdle: () => events.push("idle"),
    }

    await runTaskDispatcher({
        sources: [source],
        stopWhenEmpty: true,
        runOrchestratorFn: async () => {
            throw new Error("boom")
        },
        reporter,
        pollIntervalMs: 0,
    })

    assert.deepEqual(marks, ["failed:f1"])
    // Loop should see idle after the failing task because stopWhenEmpty breaks on empty iteration.
    assert.deepEqual(events, ["start:f1", "failure:f1", "idle"])
})
