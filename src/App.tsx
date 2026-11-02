import { useEffect, useState } from 'react';
import type { ChatEvent } from './events';

// The page never talks to Hatchet: the backend (server/server.ts) holds the token
// and relays the chat's topic. Vite proxies /api to it in development.

// source: where the page got the event, this browser's cache or the Hatchet topic
type Message = { cursor: string; event: ChatEvent; source: 'cache' | 'hatchet' };
type Conversation = { id: string; title: string };

const load = <T,>(key: string, fallback: T): T => JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
const save = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
const cacheKey = (chatId: string) => `chat:${chatId}`;

export function App() {
  const conversationId = useConversationId();
  const topic = `chat-${conversationId}`;
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState(() => load<Conversation[]>('conversations', []));
  const saveConversations = (next: Conversation[]) => {
    setConversations(next);
    save('conversations', next);
  };

  // Show what this browser has cached, then follow the topic from the last
  // cached cursor, so only newer events are read from Hatchet.
  useEffect(() => {
    let seen: Message[] = load<Message[]>(cacheKey(conversationId), []).map((m) => ({ ...m, source: 'cache' }));
    const update = (next: Message[]) => {
      seen = next;
      setMessages(next);
      save(cacheKey(conversationId), next);
    };
    setMessages(seen);
    let source: EventSource;

    const follow = (cursor?: string) => {
      source = new EventSource(`/api/chats/${conversationId}/events?cursor=${encodeURIComponent(cursor ?? '')}`);
      source.onmessage = (e) => update([...seen, { cursor: e.lastEventId, event: JSON.parse(e.data), source: 'hatchet' }]);
      // the cached cursor no longer resumes, so replay the topic from the start
      source.addEventListener('expired', () => {
        source.close();
        update([]);
        follow();
      });
    };
    follow(seen.at(-1)?.cursor);

    return () => source.close();
  }, [conversationId]);

  async function send(text: string) {
    // the backend puts the question on the topic and starts the reply; both come back over the event stream
    const res = await fetch(`/api/chats/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error('send failed:', res.status, await res.text());
      return;
    }
    if (placeholder) saveConversations([{ id: conversationId, title: text }, ...conversations]);
  }

  function remove(id: string) {
    saveConversations(conversations.filter((c) => c.id !== id));
    localStorage.removeItem(cacheKey(id));
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
              <span className={`source ${source}`}>{source}</span>
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
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
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
