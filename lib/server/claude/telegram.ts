import 'server-only';
import { getSetting, getSettingBool } from './settings';
import { getOrCreateStream } from '@/lib/server/agent/sessionOps';
import { db, claudeSessions, vps as vpsTable } from '@/lib/db';
import { eq } from 'drizzle-orm';

// ── Telegram types (subset) ─────────────────────────────────────────────────
type TgInlineKeyboard = { text: string; callback_data: string }[][];
type TgUpdate = {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; from?: { id: number } };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
};

// ── Context of sent messages (for edit after action) ────────────────────────
// MessageId → what was sent (used to edit the message after the reply).
// Also: chatId → free reply expected (sessionId+qid+qIdx) for the next
// non-button text reply.
type PermContext = { kind: 'perm'; sessionId: string; permId: string; toolName: string };
type QuestionContext = {
  kind: 'q';
  sessionId: string;
  qid: string;
  // To allow a free text reply, we store the question objects and the
  // current index we're expecting. We chain the questions if there are
  // multiple.
  questions: { question: string; options: { label: string }[]; multiSelect?: boolean }[];
  answers: Record<string, string>;
  qIdx: number;
};
type InteractionContext = PermContext | QuestionContext;

const g = globalThis as unknown as {
  _tgState?: {
    sentByMessage: Map<string, InteractionContext>;   // `${chatId}:${messageId}` → ctx
    awaitingReplyByChat: Map<string, string>;          // chatId → messageKey
    lastUpdateId: number;
    pollInterval: NodeJS.Timeout | null;
  };
};
if (!g._tgState) {
  g._tgState = {
    sentByMessage: new Map(),
    awaitingReplyByChat: new Map(),
    lastUpdateId: 0,
    pollInterval: null,
  };
}
const state = g._tgState;

// ── Helpers ─────────────────────────────────────────────────────────────────
function configured(): { token: string; chatId: string } | null {
  if (!getSettingBool('telegram.enabled')) return null;
  const token = (getSetting('telegram.bot_token') ?? '').trim();
  const chatId = (getSetting('telegram.chat_id') ?? '').trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

// Build an absolute deep-link from a relative path (e.g. `/?session=<id>`)
// using the configured public base URL (`app.public_url`). Returns null when
// no base URL is set (→ callers append no link). The hub binds to HOST:PORT
// locally and can't infer its own public origin, hence the explicit setting.
function deepLink(path: string): string | null {
  const base = (getSetting('app.public_url') ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}

// undici's `fetch` throws a terse TypeError('fetch failed') on ANY network-
// level failure; the ACTIONABLE reason (DNS, timeout, ECONNRESET / stale
// keep-alive socket "other side closed", IPv6 unreachable…) lives in `.cause`
// (and `.cause.errors` for Happy-Eyeballs aggregates). Flatten it so the
// Settings "test" surfaces something better than a bare "fetch failed".
function describeFetchError(e: any): string {
  const parts: string[] = [];
  const top = e?.message ? String(e.message) : String(e);
  if (top) parts.push(top);
  const c = e?.cause;
  if (c) {
    if (c.code) parts.push(String(c.code));
    if (c.message && c.message !== top) parts.push(String(c.message));
    if (Array.isArray(c.errors)) {
      for (const sub of c.errors) {
        const m = `${sub?.code ?? ''} ${sub?.message ?? ''}`.trim();
        if (m) parts.push(m);
      }
    }
  }
  return Array.from(new Set(parts.filter(Boolean))).join(' — ');
}

// Default per-call timeout so a hung connection can't freeze the request.
// getUpdates long-polls (timeout:20) and passes a LARGER budget explicitly —
// keep this above any long-poll value used below.
const TG_CALL_TIMEOUT_MS = 15_000;

async function tgCall<T = any>(
  method: string, body: any, tokenOverride?: string, timeoutMs: number = TG_CALL_TIMEOUT_MS,
): Promise<T> {
  const token = tokenOverride ?? (configured()?.token);
  if (!token) throw new Error('telegram not configured');
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError') {
      throw new Error(`tg ${method}: timed out after ${timeoutMs}ms reaching api.telegram.org`);
    }
    throw new Error(`tg ${method}: ${describeFetchError(e)}`);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(`tg ${method}: ${data.description ?? 'unknown'}`);
  return data.result as T;
}

function escapeMd(s: string): string {
  // MarkdownV2 escape — handy for `code` blocks
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}

// Telegram's callback_data is limited to 64 bytes. We use indices.
function sessionLabel(sessionId: string): string {
  try {
    const [s] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
    if (!s) return sessionId.slice(0, 8);
    let vpsName = '';
    if (s.vpsId) {
      const [v] = db.select({ name: vpsTable.name }).from(vpsTable).where(eq(vpsTable.id, s.vpsId)).all();
      if (v?.name) vpsName = v.name;
    }
    const base = s.name || (s.cwd ? s.cwd.split('/').slice(-2).join('/') : sessionId.slice(0, 8));
    return vpsName ? `${vpsName} · ${base}` : base;
  } catch {}
  return sessionId.slice(0, 8);
}

// ── Send: permission ────────────────────────────────────────────────────────
export async function sendPermissionToTelegram(
  sessionId: string, permId: string, tool: string, input: any
): Promise<void> {
  const cfg = configured();
  if (!cfg) return;
  const name = sessionLabel(sessionId);
  const summary = typeof input === 'object' ? JSON.stringify(input).slice(0, 300) : String(input).slice(0, 300);
  const link = deepLink(`/?session=${sessionId}`);
  const text =
    `🔒 *Permission* — _${escapeMd(name)}_\n` +
    `tool: \`${escapeMd(tool)}\`\n` +
    `\`\`\`\n${summary.slice(0, 600)}\n\`\`\`` +
    // MarkdownV2 inline link: inside (...) only ')' and '\' need escaping —
    // our hex-id URLs contain neither, so no escaping required.
    (link ? `\n[↗ open in Charon](${link})` : '');
  const keyboard: TgInlineKeyboard = [
    [
      { text: '✓ Allow', callback_data: `p|a|${permId}` },
      { text: '⏵ Always', callback_data: `p|s|${permId}` },
      { text: '✗ Deny', callback_data: `p|d|${permId}` },
    ],
  ];
  try {
    const res = await tgCall<{ message_id: number; chat: { id: number } }>('sendMessage', {
      chat_id: cfg.chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
    const key = `${res.chat.id}:${res.message_id}`;
    state.sentByMessage.set(key, { kind: 'perm', sessionId, permId, toolName: tool });
  } catch (e: any) {
    console.warn('[telegram] sendPermission:', e?.message ?? e);
  }
}

// ── Send: question (AskUserQuestion) ────────────────────────────────────────
// We send one message per question (if there are several). On each click,
// chain with the next. Once all are answered, send the reply to the worker.
export async function sendQuestionToTelegram(
  sessionId: string, qid: string,
  questions: Array<{ question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }>
): Promise<void> {
  const cfg = configured();
  if (!cfg) return;
  await sendOneQuestionStep(sessionId, qid, questions, {}, 0);
}

async function sendOneQuestionStep(
  sessionId: string, qid: string,
  questions: Array<{ question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }>,
  answersSoFar: Record<string, string>,
  qIdx: number,
): Promise<void> {
  const cfg = configured();
  if (!cfg) return;
  const q = questions[qIdx];
  if (!q) return;
  const name = sessionLabel(sessionId);
  const header = q.header ? ` *_${escapeMd(q.header)}_*\n` : '';
  const progress = questions.length > 1 ? `  \\(${qIdx + 1}/${questions.length}\\)` : '';
  const link = deepLink(`/?session=${sessionId}`);
  const text =
    `❓ *Question*${progress} — _${escapeMd(name)}_\n` +
    header +
    `${escapeMd(q.question)}\n\n` +
    `_${q.multiSelect ? 'multiple choices possible' : 'pick an option'} or type your reply_` +
    (link ? `\n\n[↗ open in Charon](${link})` : '');
  const keyboard: TgInlineKeyboard = [];
  q.options.forEach((opt, oi) => {
    const label = opt.label.length > 60 ? opt.label.slice(0, 57) + '…' : opt.label;
    keyboard.push([{ text: label, callback_data: `q|${qid}|${qIdx}|${oi}` }]);
  });
  try {
    const res = await tgCall<{ message_id: number; chat: { id: number } }>('sendMessage', {
      chat_id: cfg.chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
    const key = `${res.chat.id}:${res.message_id}`;
    const ctx: QuestionContext = {
      kind: 'q', sessionId, qid, questions, answers: answersSoFar, qIdx,
    };
    state.sentByMessage.set(key, ctx);
    // Mark this chat as possibly awaiting a free reply
    state.awaitingReplyByChat.set(String(res.chat.id), key);
  } catch (e: any) {
    console.warn('[telegram] sendQuestion:', e?.message ?? e);
  }
}

// ── Edit a message after action (to show "✓ Allowed" etc.) ──────────────────
async function tagMessageAsResolved(chatId: number, messageId: number, label: string): Promise<void> {
  const cfg = configured();
  if (!cfg) return;
  try {
    await tgCall('editMessageReplyMarkup', {
      chat_id: chatId, message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] },
    });
  } catch {}
}

// ── Polling getUpdates ──────────────────────────────────────────────────────
async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const cfg = configured();
      if (!cfg) {
        await sleep(5_000);
        continue;
      }
      const updates = await tgCall<TgUpdate[]>('getUpdates', {
        offset: state.lastUpdateId + 1,
        timeout: 20,
        allowed_updates: ['message', 'callback_query'],
      }, cfg.token, 30_000); // budget must exceed the 20s long-poll above
      for (const u of updates) {
        state.lastUpdateId = Math.max(state.lastUpdateId, u.update_id);
        try {
          await handleUpdate(u);
        } catch (e: any) {
          console.warn('[telegram] handleUpdate:', e?.message ?? e);
        }
      }
    } catch (e: any) {
      // If not configured, or a one-off error, wait.
      const msg = String(e?.message ?? e);
      if (!msg.includes('not configured')) {
        console.warn('[telegram] poll error:', msg);
      }
      await sleep(3_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleUpdate(u: TgUpdate): Promise<void> {
  if (u.callback_query) return handleCallback(u.callback_query);
  if (u.message?.text) return handleText(u.message);
}

async function handleCallback(cb: NonNullable<TgUpdate['callback_query']>): Promise<void> {
  const cfg = configured();
  if (!cfg) return;
  // chat_id filter: only react to the configured chat (basic security)
  if (cb.message && String(cb.message.chat.id) !== cfg.chatId) {
    await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: 'chat not authorized' });
    return;
  }
  await tgCall('answerCallbackQuery', { callback_query_id: cb.id }); // dismiss spinner
  const data = cb.data ?? '';
  if (data === 'noop' || !cb.message) return;
  const parts = data.split('|');
  // permission: "p|a|<permId>" | "p|s|<permId>" | "p|d|<permId>"
  if (parts[0] === 'p') {
    const action = parts[1];
    const permId = parts[2];
    const ctxKey = `${cb.message.chat.id}:${cb.message.message_id}`;
    const ctx = state.sentByMessage.get(ctxKey);
    if (!ctx || ctx.kind !== 'perm') return;
    const w = getOrCreateStream(ctx.sessionId);
    if (!w) {
      await tagMessageAsResolved(cb.message.chat.id, cb.message.message_id, '⚠ session inactive');
      return;
    }
    let label = '';
    try {
      if (action === 'a') { await w.respondPermission(permId, true, false); label = '✓ allowed'; }
      else if (action === 's') { await w.respondPermission(permId, true, true); label = '⏵ always allowed'; }
      else if (action === 'd') { await w.respondPermission(permId, false, false); label = '✗ denied'; }
      else return;
    } catch (e: any) {
      label = '⚠ ' + (e?.message ?? 'error');
    }
    await tagMessageAsResolved(cb.message.chat.id, cb.message.message_id, label);
    state.sentByMessage.delete(ctxKey);
    state.awaitingReplyByChat.delete(String(cb.message.chat.id));
    return;
  }
  // question: "q|<qid>|<qIdx>|<optIdx>"
  if (parts[0] === 'q') {
    const qid = parts[1];
    const qIdx = Number(parts[2]);
    const optIdx = Number(parts[3]);
    const ctxKey = `${cb.message.chat.id}:${cb.message.message_id}`;
    const ctx = state.sentByMessage.get(ctxKey);
    if (!ctx || ctx.kind !== 'q' || ctx.qid !== qid) return;
    const q = ctx.questions[qIdx];
    if (!q) return;
    const opt = q.options[optIdx];
    if (!opt) return;
    // If multiSelect, we'd aggregate (separated by ", ") but Telegram doesn't
    // really have a "submit" — for simplicity, in multiSelect we treat the
    // click as the final selection (1 option per Telegram call). User can
    // type free text if they want multiple.
    ctx.answers[q.question] = opt.label;
    await tagMessageAsResolved(cb.message.chat.id, cb.message.message_id, `→ ${opt.label.slice(0, 40)}`);
    state.sentByMessage.delete(ctxKey);
    state.awaitingReplyByChat.delete(String(cb.message.chat.id));
    // Next question or finish
    if (ctx.qIdx + 1 < ctx.questions.length) {
      await sendOneQuestionStep(ctx.sessionId, ctx.qid, ctx.questions, ctx.answers, ctx.qIdx + 1);
    } else {
      const w = getOrCreateStream(ctx.sessionId);
      if (w) {
        try { await w.respondQuestion(ctx.qid, ctx.answers); } catch {}
      }
    }
    return;
  }
}

async function handleText(msg: NonNullable<TgUpdate['message']>): Promise<void> {
  const cfg = configured();
  if (!cfg) return;
  if (String(msg.chat.id) !== cfg.chatId) return;
  const chatKey = String(msg.chat.id);
  const awaitingMsgKey = state.awaitingReplyByChat.get(chatKey);
  if (!awaitingMsgKey) return; // no question pending, ignore
  const ctx = state.sentByMessage.get(awaitingMsgKey);
  if (!ctx || ctx.kind !== 'q') return;
  const q = ctx.questions[ctx.qIdx];
  if (!q) return;
  const userText = msg.text!.trim();
  if (!userText) return;
  ctx.answers[q.question] = userText;
  // Mark the question as answered
  const [chat, mid] = awaitingMsgKey.split(':');
  await tagMessageAsResolved(Number(chat), Number(mid), `→ ${userText.slice(0, 40)}`);
  state.sentByMessage.delete(awaitingMsgKey);
  state.awaitingReplyByChat.delete(chatKey);
  if (ctx.qIdx + 1 < ctx.questions.length) {
    await sendOneQuestionStep(ctx.sessionId, ctx.qid, ctx.questions, ctx.answers, ctx.qIdx + 1);
  } else {
    const w = getOrCreateStream(ctx.sessionId);
    if (w) {
      try { await w.respondQuestion(ctx.qid, ctx.answers); } catch {}
    }
  }
}

// ── Bot lifecycle ──────────────────────────────────────────────────────────
export function startTelegramBot(): void {
  if (state.pollInterval != null) return; // already started
  // Start the poll loop (non-blocking). We store a flag, not the interval
  // (poll is an async loop).
  state.pollInterval = setTimeout(() => {
    pollLoop().catch((e) => console.warn('[telegram] poll crashed:', e));
  }, 0);
}

// ── Notify the workers that an interaction was resolved elsewhere ──────────
// (to call from SessionWorker when interaction_resolved is broadcast, to
// signal we must "consume" the corresponding Telegram message)
export function markInteractionResolvedInTelegram(_kind: 'permission' | 'question' | 'exit_plan', interactionId: string): void {
  // Look for the related Telegram message and edit it
  for (const [key, ctx] of state.sentByMessage.entries()) {
    if (ctx.kind === 'perm' && ctx.permId === interactionId) {
      const [chat, mid] = key.split(':');
      tagMessageAsResolved(Number(chat), Number(mid), 'resolved from dashboard').catch(() => {});
      state.sentByMessage.delete(key);
    } else if (ctx.kind === 'q' && ctx.qid === interactionId) {
      const [chat, mid] = key.split(':');
      tagMessageAsResolved(Number(chat), Number(mid), 'resolved from dashboard').catch(() => {});
      state.sentByMessage.delete(key);
      state.awaitingReplyByChat.delete(chat);
    }
  }
}

// ── Generic plain-text notification ─────────────────────────────────────────
// Fire-and-forget plain text (no buttons, no MarkdownV2 escaping headaches).
// Used by the shell-idle "finished something" notification. No-op + swallow
// if Telegram isn't configured, so callers don't need to guard.
// `linkPath` (optional, e.g. `/?session=<id>` or `/?shell=<id>`) is turned
// into an absolute deep-link via `app.public_url` and appended on its own
// line; Telegram auto-links the raw URL (plain text, no parse_mode). No link
// when `app.public_url` is unset.
export async function sendPlainToTelegram(text: string, linkPath?: string): Promise<void> {
  const cfg = configured();
  if (!cfg) return;
  const link = linkPath ? deepLink(linkPath) : null;
  const body = link ? `${text}\n${link}` : text;
  try {
    await tgCall('sendMessage', { chat_id: cfg.chatId, text: body, disable_web_page_preview: true });
  } catch (e: any) {
    console.warn('[telegram] sendPlain:', e?.message ?? e);
  }
}

// ── Configuration test (sent from the Settings UI) ──────────────────────────
export async function sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
  const cfg = configured();
  if (!cfg) return { ok: false, error: 'telegram.enabled=false or bot_token/chat_id missing' };
  // One quick retry: undici can reuse a stale keep-alive socket left by the
  // getUpdates poll loop and throw a one-off "fetch failed" that succeeds on a
  // fresh connection. The retry absorbs exactly that transient blip.
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await tgCall('sendMessage', {
        chat_id: cfg.chatId,
        text: '✓ Charon hub — Telegram connection OK. Questions and permissions will arrive here.',
      });
      return { ok: true };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (attempt < 2) await sleep(800);
    }
  }
  return { ok: false, error: lastErr };
}
