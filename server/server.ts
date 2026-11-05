import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChatEvent, ChatInput } from '../src/events';

// reads HATCHET_CLIENT_TOKEN from the environment
const hatchet = HatchetClient.init();
const app = new Hono();

// chat ids must be UUIDs, so the browser can't name arbitrary topics
const chat = '/api/chats/:id{[0-9a-f-]{36}}';
const topicFor = (id: string) => `chat-${id}`;

// Puts the question on the topic and starts a reply; both come back to the page over /events.
app.post(`${chat}/messages`, async (c) => {
  const { text } = await c.req.json<{ text?: unknown }>().catch(() => ({ text: undefined }));
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) {
    return c.json({ error: 'text must be 1-8000 characters' }, 400);
  }

  const topic = topicFor(c.req.param('id'));
  const turnId = randomUUID();
  // the question goes on the topic too, so the topic holds the whole conversation
  await hatchet.streams.publish(topic, JSON.stringify({ type: 'user', turnId, text } satisfies ChatEvent));
  await hatchet.runNoWait('chat-reply', { topic, turnId, message: text } satisfies ChatInput, {});
  return c.json({ turnId }, 202);
});

// Relays the topic as server-sent events whose ids are cursors. EventSource resends the
// last id when it reconnects, and the page passes ?cursor= to resume after its cache.
app.get(`${chat}/events`, (c) => {
  const cursor = c.req.header('Last-Event-ID') || c.req.query('cursor') || undefined;

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());

    try {
      for await (const { cursor: id, payload } of hatchet.streams.subscribe(topicFor(c.req.param('id')), {
        cursor,
        signal: controller.signal,
      })) {
        await stream.writeSSE({ id, data: new TextDecoder().decode(payload) });
      }
    } catch (err) {
      // gRPC INVALID_ARGUMENT or OUT_OF_RANGE: the cursor is unreadable or older than the
      // topic keeps, so the page drops its cache and rereads from the start
      const code = (err as { code?: number }).code;
      if (cursor && (code === 3 || code === 11)) await stream.writeSSE({ event: 'expired', data: '{}' });
      else if (!controller.signal.aborted) console.error(err);
    }
  });
});

serve({ fetch: app.fetch, port: 8787 }, () => console.log('chat backend listening on http://localhost:8787'));
