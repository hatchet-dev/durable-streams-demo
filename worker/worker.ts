import Anthropic from '@anthropic-ai/sdk';
import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import type { ChatEvent, ChatInput } from '../src/events';

// reads HATCHET_CLIENT_TOKEN and HATCHET_CLIENT_TLS_STRATEGY from the environment
const hatchet = HatchetClient.init();
// reads ANTHROPIC_API_KEY from the environment
const anthropic = new Anthropic();

// The topic is the conversation's history, so the worker reads it back to give
// the model the earlier turns, stopping at the question it's answering.
async function history(topic: string, turnId: string): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const turns = new Map<string, { question: string; answer: string; done: boolean }>();
  const controller = new AbortController();

  for await (const { payload } of hatchet.streams.subscribe(topic, { signal: controller.signal })) {
    const event: ChatEvent = JSON.parse(new TextDecoder().decode(payload));
    if (event.type === 'user') {
      if (event.turnId === turnId) break;
      turns.set(event.turnId, { question: event.text, answer: '', done: false });
    }
    const turn = turns.get(event.turnId);
    if (!turn) continue;
    if (event.type === 'delta') turn.answer += event.text;
    if (event.type === 'done') turn.done = true;
  }
  controller.abort();

  return [...turns.values()]
    .filter((t) => t.done && t.answer)
    .flatMap((t): Anthropic.Beta.BetaMessageParam[] => [
      { role: 'user', content: t.question },
      { role: 'assistant', content: t.answer },
    ]);
}

// Writes one reply. Everything it does is published to the conversation's
// topic as it happens, so any browser following the topic sees it live.
const chatReply = hatchet.task({
  name: 'chat-reply',
  fn: async ({ topic, turnId, message }: ChatInput) => {
    const publish = (event: ChatEvent) => hatchet.streams.publish(topic, JSON.stringify(event));

    await publish({ type: 'status', turnId, text: 'Thinking…' });

    try {
      const stream = anthropic.beta.messages.stream({
        model: 'claude-opus-5-5',
        max_tokens: 64000,
        // chat replies don't need deep reasoning, and low effort keeps the first word quick
        output_config: { effort: 'low' },
        // retries a safety decline on Anthropic's recommended fallback model
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: 'You are a helpful assistant in a chat app. Keep replies concise and conversational.',
        messages: [...(await history(topic, turnId)), { role: 'user', content: message }],
      });

      let wrote = false;
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          wrote = true;
          await publish({ type: 'delta', turnId, text: event.delta.text });
        }
      }

      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        await publish({ type: 'delta', turnId, text: `${wrote ? '\n\n' : ''}(Claude declined to answer this.)` });
      }
    } catch (err) {
      const reason = err instanceof Anthropic.APIError ? `API error ${err.status}: ${err.message}` : String(err);
      await publish({ type: 'delta', turnId, text: `(Something went wrong: ${reason})` });
      throw err;
    } finally {
      // always end the turn, so the page doesn't wait on it forever
      await publish({ type: 'done', turnId });
    }
  },
});

const worker = await hatchet.worker('chat-worker', { workflows: [chatReply] });
await worker.start();
