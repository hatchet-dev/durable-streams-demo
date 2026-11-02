// Each conversation is one durable stream topic. Every message on it is one of
// these events, as JSON: the browser publishes the user's question, and the
// worker publishes the reply's progress.
export type ChatEvent =
  | { type: 'user'; turnId: string; text: string }
  | { type: 'status'; turnId: string; text: string }
  | { type: 'delta'; turnId: string; text: string }
  | { type: 'done'; turnId: string };

// the input of the `chat-reply` task
export type ChatInput = { topic: string; turnId: string; message: string };
