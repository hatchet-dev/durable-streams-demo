import { Hatchet } from '@hatchet-dev/typescript-sdk/core';
import { useEffect, useState } from 'react';
import type { ChatEvent, ChatInput } from './events';

// The SDK's fetch-based client talks to the Hatchet engine straight from the
// browser. (A real app would give the browser a scoped token, not a tenant API token.)
const hatchet = new Hatchet({
  token: import.meta.env.HATCHET_CLIENT_TOKEN,
  // the local engine serves plain HTTP
  tls: { strategy: 'none' },
});

// where the page got an event: this browser's cache, or a read from the Hatchet topic
type Source = 'cache' | 'hatchet';
type Message = { cursor: string; event: ChatEvent; source: Source };
type Conversation = { id: string; title: string };

const cacheKey = (topic: string) => `topic:${topic}`;

function readCache(topic: string): Message[] {
  try {
    const cached: Message[] = JSON.parse(localStorage.getItem(cacheKey(topic)) ?? '[]');
    return cached.map((m) => ({ ...m, source: 'cache' }));
  } catch {
    return [];
  }
}

function writeCache(topic: string, messages: Message[]) {
  try {
    localStorage.setItem(cacheKey(topic), JSON.stringify(messages));
  } catch {
    // a full or blocked localStorage only costs the next load a full replay
  }
}

export function App() {
  const conversationId = useConversationId();
  const topic = `chat-${conversationId}`;
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    JSON.parse(localStorage.getItem('conversations') ?? '[]')
  );

  // Show what this browser has cached, then follow the topic from the last
  // cached cursor, so only newer events are read from Hatchet.
  useEffect(() => {
    let seen = readCache(topic);
    setMessages(seen);
    const controller = new AbortController();

    (async () => {
      const follow = async (cursor?: string) => {
        for await (const { cursor: next, payload } of hatchet.streams.subscribe(topic, {
          cursor,
          signal: controller.signal,
        })) {
          const event: ChatEvent = JSON.parse(new TextDecoder().decode(payload));
          seen = [...seen, { cursor: next, event, source: 'hatchet' }];
          setMessages(seen);
          writeCache(topic, seen);
        }
      };

      try {
        await follow(seen.at(-1)?.cursor);
      } catch (err) {
        if (controller.signal.aborted || !seen.length) throw err;
        // the cached cursor no longer resumes (e.g. it expired), so replay the topic from the start
        seen = [];
        setMessages(seen);
        writeCache(topic, seen);
        await follow();
      }
    })().catch(console.error);

    return () => controller.abort();
  }, [topic]);

  async function send(text: string) {
    const turnId = crypto.randomUUID();
    const question: ChatEvent = { type: 'user', turnId, text };
    const input: ChatInput = { topic, turnId, message: text };

    // The question goes on the topic too, so the topic holds the whole conversation.
    await hatchet.streams.publish(topic, JSON.stringify(question));
    await hatchet.runNoWait('chat-reply', input);

    if (!conversations.some((c) => c.id === conversationId)) {
      const next = [{ id: conversationId, title: text }, ...conversations];
      setConversations(next);
      localStorage.setItem('conversations', JSON.stringify(next));
    }
  }

  function remove(id: string) {
    const next = conversations.filter((c) => c.id !== id);
    setConversations(next);
    localStorage.setItem('conversations', JSON.stringify(next));
    localStorage.removeItem(cacheKey(`chat-${id}`));
    if (id === conversationId) location.hash = crypto.randomUUID();
  }

  const turns = toTurns(messages.map((m) => m.event));
  const busy = turns.some((t) => !t.done);
  const fromCache = messages.filter((m) => m.source === 'cache').length;
  // the open chat stays a placeholder until its first message adds it to the list
  const placeholder = !conversations.some((c) => c.id === conversationId);

  return (
    <div className="app">
      <nav className="sidebar">
        <a className="new" href={`#${crypto.randomUUID()}`}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New chat
        </a>
        {placeholder && (
          <div className="conversation active placeholder">
            <a href={`#${conversationId}`}>{turns[0]?.question ?? 'New chat'}</a>
          </div>
        )}
        {conversations.map((c) => (
          <div key={c.id} className={`conversation${c.id === conversationId ? ' active' : ''}`}>
            <a href={`#${c.id}`}>{c.title}</a>
            <button type="button" className="delete" aria-label={`Delete "${c.title}"`} onClick={() => remove(c.id)}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ))}
      </nav>

      <main className="chat">
        <div className="messages">
          <div>
            {turns.map((t) => (
            <div key={t.turnId} className="turn">
              <div className="user">{t.question}</div>
              {t.answer ? (
                <div className="assistant">
                  {t.answer}
                  {!t.done && <span className="caret" />}
                </div>
              ) : (
                <div className="assistant status">
                  <span className="spinner" />
                  {t.status ?? 'Waiting for a worker…'}
                </div>
              )}
            </div>
            ))}
          </div>
        </div>
        <Composer disabled={busy} onSend={send} />
      </main>

      <aside className="inspector">
        <header>
          <code>{topic}</code>
          <span className="sources">
            <span className="source cache">cache</span> {fromCache}
            <span className="source hatchet">hatchet</span> {messages.length - fromCache}
          </span>
        </header>
        <div className="log">
          <div>
            {messages.map(({ cursor, event, source }) => (
            <div key={cursor} className="row">
              <span className={`source ${source}`} title={source === 'cache' ? 'from this browser\'s cache' : 'read from the Hatchet topic'}>
                {source}
              </span>
              <span className="tag">{event.type}</span>
              <span className="text">{'text' in event ? JSON.stringify(event.text) : ''}</span>
              <span className="cursor" title={cursor}>
                {cursor.slice(-8)}
              </span>
            </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

type Turn = { turnId: string; question: string; status?: string; answer: string; done: boolean };

// Folds the topic's events into question-and-answer pairs.
function toTurns(events: ChatEvent[]): Turn[] {
  const turns = new Map<string, Turn>();
  for (const event of events) {
    if (event.type === 'user') {
      turns.set(event.turnId, { turnId: event.turnId, question: event.text, answer: '', done: false });
    }
    const turn = turns.get(event.turnId);
    if (!turn) continue;
    if (event.type === 'status') turn.status = event.text;
    if (event.type === 'delta') turn.answer += event.text;
    if (event.type === 'done') turn.done = true;
  }
  return [...turns.values()];
}

// The conversation id is the URL hash, so a link (or a reload) opens the same conversation.
function useConversationId(): string {
  const read = () => {
    if (!location.hash) history.replaceState(null, '', `#${crypto.randomUUID()}`);
    return location.hash.slice(1);
  };
  const [id, setId] = useState(read);
  useEffect(() => {
    const onChange = () => setId(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return id;
}

function Composer({ disabled, onSend }: { disabled: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim() || disabled) return;
        onSend(text.trim());
        setText('');
      }}
    >
      <input value={text} placeholder="Message" onChange={(e) => setText(e.target.value)} autoFocus />
      <button type="submit" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}
