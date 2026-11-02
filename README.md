# Streams Chat

A chatbot built on Hatchet durable streams, with no backend of its own. The browser talks to the Hatchet engine
directly, and a Hatchet worker writes the replies.

Each conversation is one stream topic. The topic holds every event in the conversation, so it is the conversation's
history as well as its live feed.

1. **The browser** publishes the question to the topic and triggers the `chat-reply` task (`src/App.tsx`):

   ```ts
   await hatchet.streams.publish(topic, JSON.stringify({ type: 'user', turnId, text }));
   await hatchet.runNoWait('chat-reply', { topic, turnId, message: text });
   ```

2. **The worker** runs `chat-reply`: it reads the topic back for the earlier turns, streams a reply from Claude, and
   publishes it to the same topic as it goes: a "Thinking…" status, then each text delta, then `done`
   (`worker/worker.ts`):

   ```ts
   await hatchet.streams.publish(topic, JSON.stringify({ type: 'delta', turnId, text: word }));
   ```

3. **The browser** reads the topic from its first event and keeps following it, folding the events into
   question-and-answer pairs:

   ```ts
   for await (const { cursor, payload } of hatchet.streams.subscribe(topic, { signal })) { … }
   ```

Because the page always reads the topic from the start, a reload, or the same URL in another tab, shows the whole
conversation, including a reply that's still being written. The panel on the right lists the raw events and their
cursors. The event shapes are in `src/events.ts`.

The browser uses the SDK's fetch-based client, `@hatchet-dev/typescript-sdk/core`, and the worker uses the regular
Node client and the Anthropic SDK.

## Running

```bash
pnpm install
pnpm hatchet   # terminal 1: the local engine (:7095) and API (:8098)
pnpm worker    # terminal 2
pnpm dev       # terminal 3: http://localhost:5199
```

Both the worker and the page read `HATCHET_CLIENT_TOKEN` from `.env`, and the worker reads `ANTHROPIC_API_KEY` from
it too. Vite only exposes `HATCHET_CLIENT_*` variables, so the Anthropic key never reaches the browser. The page gets a tenant API token, which is fine
for a local demo; a real app should give the browser a scoped token instead.

## Local setup notes

- **SDK:** linked from `../hatchet-workstation/repos/hatchet/sdks/typescript/dist`. That checkout (the `durablestreamsdemo` branch) adds `subscribe()` to the
  `core` client. Rebuild it after changing the SDK, with `pnpm run tsc:build && cp package.json dist/` in
  `sdks/typescript`, then restart Vite with `pnpm dev --force`: Vite caches its bundle of the linked SDK and won't
  notice the rebuild otherwise.
- **Engine:** `scripts/hatchet.env` runs an isolated instance on the hatchet repo's docker-compose Postgres, using its own
  `durablestreamsdemo` database (which also carries the message queue) and its own ports. The binaries in
  `.hatchet/bin` are built from the hatchet repo's `durablestreamsdemo` branch, which adds CORS to the engine (`internal/services/grpc/cors.go`), without which the browser can't
  call the engine.
- **One-time setup** (already done):

  ```bash
  docker exec hatchet-postgres-1 psql -U hatchet -d hatchet -c 'CREATE DATABASE durablestreamsdemo'
  source scripts/hatchet.env && .hatchet/bin/hatchet-migrate && .hatchet/bin/hatchet-admin seed
  # durable streams are a tenant entitlement, off by default
  docker exec hatchet-postgres-1 psql -U hatchet -d durablestreamsdemo -c \
    "UPDATE tenant_entitlement SET durable_streams = true WHERE tenant_id = '707d0855-80ab-4e1f-a156-f1c4546cbf52'"
  .hatchet/bin/hatchet-admin token create --tenant-id 707d0855-80ab-4e1f-a156-f1c4546cbf52 --expiresIn 87600h | tail -1 > .hatchet/token
  printf 'HATCHET_CLIENT_TOKEN=%s\nHATCHET_CLIENT_TLS_STRATEGY=none\n' "$(cat .hatchet/token)" > .env
  ```
