import type { EnqueuedTask, TaskSource } from "../taskDispatcher.js";

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
  description?: string;
}

export interface TelegramApiGetUpdatesParams {
  offset?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export interface TelegramApiClient {
  getUpdates(params?: TelegramApiGetUpdatesParams): Promise<TelegramUpdate[]>;
  sendMessage(params: { chat_id: number; text: string }): Promise<void>;
}

class FetchTelegramApiClient implements TelegramApiClient {
  private readonly baseUrl: string;

  constructor(private readonly token: string, baseUrl?: string) {
    this.baseUrl = baseUrl ?? `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(params: TelegramApiGetUpdatesParams = {}): Promise<TelegramUpdate[]> {
    const url = new URL(`${this.baseUrl}/getUpdates`);

    if (params.offset !== undefined) url.searchParams.set("offset", String(params.offset));
    if (params.timeout !== undefined) url.searchParams.set("timeout", String(params.timeout));
    if (params.allowed_updates?.length) {
      url.searchParams.set("allowed_updates", JSON.stringify(params.allowed_updates));
    }

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Telegram API responded with status ${response.status}`);
    }

    const json = (await response.json()) as TelegramGetUpdatesResponse;
    if (!json.ok) {
      throw new Error(`Telegram API error: ${json.description ?? "unknown error"}`);
    }

    return json.result ?? [];
  }

  async sendMessage(params: { chat_id: number; text: string }): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: params.chat_id, text: params.text }),
    });

    if (!response.ok) {
      throw new Error(`Telegram API responded with status ${response.status} on sendMessage`);
    }

    const json = await response.json();
    if (!json?.ok) {
      throw new Error(`Telegram API error on sendMessage: ${json?.description ?? "unknown error"}`);
    }
  }
}

export interface TelegramTaskSourceOptions {
  token: string;
  adminUserId: number;
  pollTimeoutSeconds?: number;
  client?: TelegramApiClient;
  sourceName?: string;
}

/**
 * Task source backed by a Telegram bot. Any text message from the configured admin user
 * becomes a task description.
 */
export class TelegramTaskSource implements TaskSource {
  public readonly name: string;
  private readonly adminUserId: number;
  private readonly pollTimeoutSeconds: number;
  private readonly client: TelegramApiClient;
  private offset?: number;
  private queue: EnqueuedTask[] = [];
  private readonly maxMessageLength = 3500; // Telegram limit is 4096; keep margin.

  constructor(options: TelegramTaskSourceOptions) {
    this.adminUserId = options.adminUserId;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
    this.client = options.client ?? new FetchTelegramApiClient(options.token);
    this.name = options.sourceName ?? "telegram";
  }

  async nextTask(): Promise<EnqueuedTask | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }

    await this.pollOnce();
    return this.queue.shift() ?? null;
  }

  private async pollOnce() {
    try {
      const updates = await this.client.getUpdates({
        offset: this.offset,
        timeout: this.pollTimeoutSeconds,
        allowed_updates: ["message"],
      });

      if (updates.length > 0) {
        const lastId = updates[updates.length - 1].update_id;
        this.offset = lastId + 1;
      }

      for (const update of updates) {
        this.maybeEnqueue(update);
      }
    } catch (error) {
      console.error("[telegram-task-source] Poll failed:", error);
    }
  }

  private maybeEnqueue(update: TelegramUpdate) {
    const message = update.message;
    if (!message) return;
    if (!message.from || message.from.id !== this.adminUserId) return;
    const text = message.text?.trim();
    if (!text) return;

    this.queue.push({
      id: `tg-${update.update_id}`,
      description: text,
      source: this.name,
      metadata: {
        messageId: message.message_id,
        chatId: message.chat.id,
        fromId: message.from.id,
        username: message.from.username,
      },
    });
  }

  async markDone(task: EnqueuedTask, result: string): Promise<void> {
    const chatId = this.extractChatId(task);
    if (!chatId) return;

    const body = this.truncate(result);
    const text = `✅ Task ${task.id} completed.\n${body || "(empty result)"}`;

    try {
      await this.client.sendMessage({ chat_id: chatId, text });
    } catch (error) {
      console.error("[telegram-task-source] Failed to send completion message:", error);
    }
  }

  async markFailed(task: EnqueuedTask, error: Error): Promise<void> {
    const chatId = this.extractChatId(task);
    if (!chatId) return;

    const details = this.truncate(error?.stack || error?.message || String(error));
    const text = `❌ Task ${task.id} failed.\n${details}`;

    try {
      await this.client.sendMessage({ chat_id: chatId, text });
    } catch (err) {
      console.error("[telegram-task-source] Failed to send failure message:", err);
    }
  }

  private truncate(text: string): string {
    if (!text) return "";
    if (text.length <= this.maxMessageLength) return text;
    return `${text.slice(0, this.maxMessageLength)}\n[truncated ${text.length - this.maxMessageLength} chars]`;
  }

  private extractChatId(task: EnqueuedTask): number | null {
    const meta = task.metadata as { chatId?: unknown } | undefined;
    const chatId = meta?.chatId;
    return typeof chatId === "number" ? chatId : null;
  }
}
