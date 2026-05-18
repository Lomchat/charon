import 'server-only';
import { getSetting, getSettingBool } from './settings';
import { getStream } from '@/lib/server/agent/sessionOps';
import { db, claudeSessions, vps as vpsTable } from '@/lib/db';
import { eq } from 'drizzle-orm';

// ── Types Telegram (subset) ─────────────────────────────────────────────────
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

// ── Contexte des messages envoyés (pour edit après action) ──────────────────
// MessageId → ce qui a été envoyé (sert à éditer le message après réponse).
// Aussi : chatId → réponse libre attendue (sessionId+qid+qIdx) pour la prochaine
// réponse texte non-boutonnée.
type PermContext = { kind: 'perm'; sessionId: string; permId: string; toolName: string };
type QuestionContext = {
  kind: 'q';
  sessionId: string;
  qid: string;
  // Pour permettre une réponse libre par texte, on stocke les question objects
  // et l'index courant qu'on attend. On chaîne les questions si plusieurs.
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

async function tgCall<T = any>(method: string, body: any, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? (configured()?.token);
  if (!token) throw new Error('telegram not configured');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`tg ${method}: ${data.description ?? 'unknown'}`);
  return data.result as T;
}

function escapeMd(s: string): string {
  // MarkdownV2 escape — pratique pour mettre du `code`
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}

// Le callback_data Telegram est limité à 64 bytes. On utilise des indices.
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

// ── Envoi : permission ──────────────────────────────────────────────────────
export async function sendPermissionToTelegram(
  sessionId: string, permId: string, tool: string, input: any
): Promise<void> {
  const cfg = configured();
  if (!cfg) return;
  const name = sessionLabel(sessionId);
  const summary = typeof input === 'object' ? JSON.stringify(input).slice(0, 300) : String(input).slice(0, 300);
  const text =
    `🔒 *Permission* — _${escapeMd(name)}_\n` +
    `outil: \`${escapeMd(tool)}\`\n` +
    `\`\`\`\n${summary.slice(0, 600)}\n\`\`\``;
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
      reply_markup: { inline_keyboard: keyboard },
    });
    const key = `${res.chat.id}:${res.message_id}`;
    state.sentByMessage.set(key, { kind: 'perm', sessionId, permId, toolName: tool });
  } catch (e: any) {
    console.warn('[telegram] sendPermission:', e?.message ?? e);
  }
}

// ── Envoi : question (AskUserQuestion) ──────────────────────────────────────
// On envoie un message par question (s'il y en a plusieurs). À chaque clic on
// chaîne avec la suivante. Une fois toutes répondues, on envoie la réponse au
// worker.
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
  const text =
    `❓ *Question*${progress} — _${escapeMd(name)}_\n` +
    header +
    `${escapeMd(q.question)}\n\n` +
    `_${q.multiSelect ? 'plusieurs choix possibles' : 'choisis une option'} ou tape ta réponse_`;
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
      reply_markup: { inline_keyboard: keyboard },
    });
    const key = `${res.chat.id}:${res.message_id}`;
    const ctx: QuestionContext = {
      kind: 'q', sessionId, qid, questions, answers: answersSoFar, qIdx,
    };
    state.sentByMessage.set(key, ctx);
    // Marque ce chat comme attendant éventuellement une réponse libre
    state.awaitingReplyByChat.set(String(res.chat.id), key);
  } catch (e: any) {
    console.warn('[telegram] sendQuestion:', e?.message ?? e);
  }
}

// ── Edit un message après action (pour montrer "✓ Allowed" etc.) ────────────
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
      }, cfg.token);
      for (const u of updates) {
        state.lastUpdateId = Math.max(state.lastUpdateId, u.update_id);
        try {
          await handleUpdate(u);
        } catch (e: any) {
          console.warn('[telegram] handleUpdate:', e?.message ?? e);
        }
      }
    } catch (e: any) {
      // Si pas configuré, ou erreur ponctuelle, on patiente.
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
  // Filtre chat_id : on ne réagit qu'au chat configuré (sécu basique)
  if (cb.message && String(cb.message.chat.id) !== cfg.chatId) {
    await tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: 'chat non autorisé' });
    return;
  }
  await tgCall('answerCallbackQuery', { callback_query_id: cb.id }); // dismiss spinner
  const data = cb.data ?? '';
  if (data === 'noop' || !cb.message) return;
  const parts = data.split('|');
  // permission : "p|a|<permId>" | "p|s|<permId>" | "p|d|<permId>"
  if (parts[0] === 'p') {
    const action = parts[1];
    const permId = parts[2];
    const ctxKey = `${cb.message.chat.id}:${cb.message.message_id}`;
    const ctx = state.sentByMessage.get(ctxKey);
    if (!ctx || ctx.kind !== 'perm') return;
    const w = getStream(ctx.sessionId);
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
      label = '⚠ ' + (e?.message ?? 'erreur');
    }
    await tagMessageAsResolved(cb.message.chat.id, cb.message.message_id, label);
    state.sentByMessage.delete(ctxKey);
    state.awaitingReplyByChat.delete(String(cb.message.chat.id));
    return;
  }
  // question : "q|<qid>|<qIdx>|<optIdx>"
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
    // Si multiSelect, on agrège (séparé par ", ") mais Telegram on n'a pas vraiment
    // de "submit" — pour simplifier, en multiSelect on traite le clic comme la
    // sélection finale (1 seule option par appel Telegram). User peut taper en
    // texte libre s'il veut plusieurs.
    ctx.answers[q.question] = opt.label;
    await tagMessageAsResolved(cb.message.chat.id, cb.message.message_id, `→ ${opt.label.slice(0, 40)}`);
    state.sentByMessage.delete(ctxKey);
    state.awaitingReplyByChat.delete(String(cb.message.chat.id));
    // Question suivante ou terminer
    if (ctx.qIdx + 1 < ctx.questions.length) {
      await sendOneQuestionStep(ctx.sessionId, ctx.qid, ctx.questions, ctx.answers, ctx.qIdx + 1);
    } else {
      const w = getStream(ctx.sessionId);
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
  if (!awaitingMsgKey) return; // pas de question en attente, on ignore
  const ctx = state.sentByMessage.get(awaitingMsgKey);
  if (!ctx || ctx.kind !== 'q') return;
  const q = ctx.questions[ctx.qIdx];
  if (!q) return;
  const userText = msg.text!.trim();
  if (!userText) return;
  ctx.answers[q.question] = userText;
  // Marque la question répondue
  const [chat, mid] = awaitingMsgKey.split(':');
  await tagMessageAsResolved(Number(chat), Number(mid), `→ ${userText.slice(0, 40)}`);
  state.sentByMessage.delete(awaitingMsgKey);
  state.awaitingReplyByChat.delete(chatKey);
  if (ctx.qIdx + 1 < ctx.questions.length) {
    await sendOneQuestionStep(ctx.sessionId, ctx.qid, ctx.questions, ctx.answers, ctx.qIdx + 1);
  } else {
    const w = getStream(ctx.sessionId);
    if (w) {
      try { await w.respondQuestion(ctx.qid, ctx.answers); } catch {}
    }
  }
}

// ── Bot lifecycle ──────────────────────────────────────────────────────────
export function startTelegramBot(): void {
  if (state.pollInterval != null) return; // déjà démarré
  // Démarre la boucle de poll (non-bloquant). On stocke un flag, pas l'interval
  // (poll est une boucle async).
  state.pollInterval = setTimeout(() => {
    pollLoop().catch((e) => console.warn('[telegram] poll crashed:', e));
  }, 0);
}

// ── Notifier les workers qu'une interaction est résolue ailleurs ───────────
// (à appeler depuis SessionWorker quand interaction_resolved est broadcasté
// pour signaler qu'on doit "consommer" le message Telegram correspondant)
export function markInteractionResolvedInTelegram(_kind: 'permission' | 'question' | 'exit_plan', interactionId: string): void {
  // Cherche le message Telegram lié et l'édite
  for (const [key, ctx] of state.sentByMessage.entries()) {
    if (ctx.kind === 'perm' && ctx.permId === interactionId) {
      const [chat, mid] = key.split(':');
      tagMessageAsResolved(Number(chat), Number(mid), 'résolu côté dashboard').catch(() => {});
      state.sentByMessage.delete(key);
    } else if (ctx.kind === 'q' && ctx.qid === interactionId) {
      const [chat, mid] = key.split(':');
      tagMessageAsResolved(Number(chat), Number(mid), 'résolu côté dashboard').catch(() => {});
      state.sentByMessage.delete(key);
      state.awaitingReplyByChat.delete(chat);
    }
  }
}

// ── Test de configuration (envoyé depuis l'UI Settings) ─────────────────────
export async function sendTestMessage(): Promise<{ ok: boolean; error?: string }> {
  try {
    const cfg = configured();
    if (!cfg) return { ok: false, error: 'telegram.enabled=false ou bot_token/chat_id manquant' };
    await tgCall('sendMessage', {
      chat_id: cfg.chatId,
      text: '✓ Hub claude — connexion Telegram OK. Les questions et permissions arriveront ici.',
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
