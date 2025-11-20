import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramTaskSource } from "../src/taskSources/telegramTaskSource.js";
import type { TelegramApiClient, TelegramApiGetUpdatesParams } from "../src/taskSources/telegramTaskSource.js";

class MockTelegramClient implements TelegramApiClient {
  private readonly updates: any[];

  constructor(updates: any[]) {
    this.updates = updates;
  }

  async getUpdates(params?: TelegramApiGetUpdatesParams) {
    const offset = params?.offset;
    return this.updates.filter((u) => offset === undefined || u.update_id >= offset);
  }
}

test("TelegramTaskSource enqueues only admin text messages", async () => {
  const updates = [
    {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 123, username: "admin" },
        chat: { id: 1, type: "private" },
        text: "Task 1",
      },
    },
    {
      update_id: 2,
      message: {
        message_id: 11,
        from: { id: 999, username: "stranger" },
        chat: { id: 1, type: "private" },
        text: "Ignore me",
      },
    },
    {
      update_id: 3,
      message: {
        message_id: 12,
        from: { id: 123, username: "admin" },
        chat: { id: 1, type: "private" },
        text: "Task 2",
      },
    },
    {
      update_id: 4,
      message: {
        message_id: 13,
        from: { id: 123, username: "admin" },
        chat: { id: 1, type: "private" },
        text: "   ",
      },
    },
  ];

  const source = new TelegramTaskSource({
    token: "fake",
    adminUserId: 123,
    client: new MockTelegramClient(updates),
    pollTimeoutSeconds: 0,
  });

  const task1 = await source.nextTask();
  const task2 = await source.nextTask();
  const task3 = await source.nextTask(); // should be null

  assert.equal(task1?.description, "Task 1");
  assert.equal(task2?.description, "Task 2");
  assert.equal(task3, null);
});

test("TelegramTaskSource advances offset to avoid duplicate tasks", async () => {
  const updates = [
    {
      update_id: 7,
      message: {
        message_id: 21,
        from: { id: 321 },
        chat: { id: 2, type: "private" },
        text: "First",
      },
    },
  ];

  const client = new MockTelegramClient(updates);
  const source = new TelegramTaskSource({
    token: "fake",
    adminUserId: 321,
    client,
    pollTimeoutSeconds: 0,
  });

  const first = await source.nextTask();
  const second = await source.nextTask();

  assert.equal(first?.description, "First");
  assert.equal(second, null, "Second poll should not return the same update again");
});
