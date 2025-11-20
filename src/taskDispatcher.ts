import { runOrchestrator, type OrchestratorRunOptions } from "./orchestratorAgent.js";

export interface EnqueuedTask {
  /**
   * Unique id for deduplication or logging (caller-provided).
   */
  id: string;
  /**
   * Human-readable description that will be passed to runOrchestrator.
   */
  description: string;
  /**
   * Identifier for the source (e.g., "telegram", "api", "tracker").
   */
  source: string;
  metadata?: Record<string, unknown>;
}

export interface TaskSource {
  name: string;
  /**
   * Return the next task or null if none are available right now.
   */
  nextTask(): Promise<EnqueuedTask | null>;
  /**
   * Optional hook after successful completion.
   */
  markDone?(task: EnqueuedTask, result: string): Promise<void>;
  /**
   * Optional hook after failure.
   */
  markFailed?(task: EnqueuedTask, error: Error): Promise<void>;
}

export interface TaskReporter {
  onStart?(task: EnqueuedTask): Promise<void> | void;
  onSuccess?(task: EnqueuedTask, result: string): Promise<void> | void;
  onFailure?(task: EnqueuedTask, error: Error): Promise<void> | void;
  onIdle?(): Promise<void> | void;
}

export interface TaskDispatcherOptions {
  /**
   * One or more task sources; they are polled in order.
   */
  sources: TaskSource[];
  /**
   * Optional reporter for lifecycle events (logging, metrics, etc.).
   */
  reporter?: TaskReporter;
  /**
   * Base directory passed down to runOrchestrator (defaults to env inside runOrchestrator).
   */
  baseDir?: string;
  /**
   * Poll interval when no tasks are available (ms).
   */
  pollIntervalMs?: number;
  /**
   * If true, exit when all sources are empty instead of polling forever.
   */
  stopWhenEmpty?: boolean;
  /**
   * For tests or custom runners; defaults to runOrchestrator.
   */
  runOrchestratorFn?: (options: OrchestratorRunOptions) => Promise<string>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultReporter(): TaskReporter {
  return new ConsoleTaskReporter();
}

export async function runTaskDispatcher(options: TaskDispatcherOptions) {
  if (!options.sources || options.sources.length === 0) {
    throw new Error("TaskDispatcher requires at least one TaskSource");
  }

  const reporter = options.reporter ?? defaultReporter();
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const stopWhenEmpty = options.stopWhenEmpty ?? false;
  const runner = options.runOrchestratorFn ?? runOrchestrator;

  while (true) {
    let processedAny = false;

    for (const source of options.sources) {
      const task = await source.nextTask();
      if (!task) {
        continue;
      }

      processedAny = true;
      await reporter.onStart?.(task);

      try {
        const result = await runner({ taskDescription: task.description, baseDir: options.baseDir });
        await reporter.onSuccess?.(task, result);
        await source.markDone?.(task, result);
      } catch (error: any) {
        const asError = error instanceof Error ? error : new Error(String(error));
        await reporter.onFailure?.(task, asError);
        await source.markFailed?.(task, asError);
      }
    }

    if (!processedAny) {
      await reporter.onIdle?.();
      if (stopWhenEmpty) {
        break;
      }
      await sleep(pollIntervalMs);
    }
  }
}

export function createInMemoryTaskSource(name: string, tasks: EnqueuedTask[]): TaskSource {
  const queue = [...tasks];

  return {
    name,
    async nextTask() {
      return queue.shift() ?? null;
    },
    async markDone() {
      // no-op
    },
    async markFailed() {
      // no-op
    },
  };
}

export class ConsoleTaskReporter implements TaskReporter {
  async onStart(task: EnqueuedTask) {
    console.log(`[dispatcher] Starting task ${task.id} from ${task.source}: ${task.description}`);
  }

  async onSuccess(task: EnqueuedTask) {
    console.log(`[dispatcher] ✅ Completed task ${task.id} from ${task.source}`);
  }

  async onFailure(task: EnqueuedTask, error: Error) {
    console.error(`[dispatcher] ❌ Task ${task.id} from ${task.source} failed:`, error);
  }

  async onIdle() {
    console.log("[dispatcher] No tasks available, sleeping...");
  }
}
