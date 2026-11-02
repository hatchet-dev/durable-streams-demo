# Streams Chat

A chatbot built on Hatchet durable streams.

Each conversation is one stream topic. The topic holds every event in the conversation, so it is the conversation's
history as well as its live feed.

1. **The browser** posts the question to the backend (`src/App.tsx`), which publishes it to the topic and triggers the
   `chat-reply` task (`server/server.ts`):

   ```ts
   await hatchet.streams.publish(topic, JSON.stringify({ type: 'user', turnId, text }));
   await hatchet.runNoWait('chat-reply', { topic, turnId, message: text }, {});
   ```

2. **The worker** runs `chat-reply`: it reads the topic back for the earlier turns, streams a reply from Claude, and
   publishes it to the same topic as it goes: a "Thinking…" status, then each text delta, then `done`
   (`worker/worker.ts`):

   ```ts
   await publish({ type: 'delta', turnId, text: event.delta.text });
   ```

3. **The backend** follows the topic and relays it to the browser as server-sent events, with each event's cursor as
   its SSE id:

   ```ts
   for await (const { cursor, payload } of hatchet.streams.subscribe(topic, { cursor, signal })) { … }
   ```

4. **The browser** folds the events into question-and-answer pairs and caches them. On a reload it shows the cache
   first and asks the backend to resume after the last cached cursor, so only newer events are read from Hatchet. If
   the connection drops, `EventSource` reconnects with the last cursor it saw.

A reload, or the same URL in another tab, shows the whole conversation, including a reply that's still being written.
The panel on the right lists the raw events and their cursors, labelled by whether each came from the browser's cache
or from Hatchet. The event shapes are in `src/events.ts`.

The backend accepts only UUID chat ids, so the browser can't name other topics, but it has no user accounts: anyone who
can reach it can read a chat whose id they know. A real app would tie chats to signed-in users.

## Running

```bash
pnpm install
pnpm hatchet   # terminal 1: the local engine (:7095) and API (:8098)
pnpm worker    # terminal 2
pnpm server    # terminal 3: the backend (:8787)
pnpm dev       # terminal 4: http://localhost:5199, proxying /api to the backend
```

The worker and the backend read `HATCHET_CLIENT_TOKEN` from `.env`, and the worker reads `ANTHROPIC_API_KEY` from it
too. The page reads nothing from `.env`: Vite only exposes `VITE_*` variables to it.
