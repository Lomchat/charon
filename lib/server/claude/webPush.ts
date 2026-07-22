import 'server-only';
import webpush from 'web-push';
import { db, claudePushSubs } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { getSetting, setSetting } from './settings';

let initialized = false;

function ensureVapid(): { publicKey: string; privateKey: string } | null {
  if (initialized) {
    const pub = getSetting('vapid.public');
    const priv = getSetting('vapid.private');
    if (!pub || !priv) return null;
    return { publicKey: pub, privateKey: priv };
  }
  let pub = getSetting('vapid.public');
  let priv = getSetting('vapid.private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    setSetting('vapid.public', keys.publicKey);
    setSetting('vapid.private', keys.privateKey);
    pub = keys.publicKey;
    priv = keys.privateKey;
  }
  const subject = getSetting('vapid.subject') ?? 'mailto:user@example.com';
  webpush.setVapidDetails(subject, pub, priv);
  initialized = true;
  return { publicKey: pub, privateKey: priv };
}

export function getVapidPublic(): string | null {
  const k = ensureVapid();
  return k?.publicKey ?? null;
}

export async function sendPushToAll(payload: {
  title: string;
  body: string;
  url?: string;
  sessionId?: string;
  tag?: string;
}): Promise<void> {
  const k = ensureVapid();
  if (!k) return;
  const subs = db.select().from(claudePushSubs).all();
  const body = JSON.stringify(payload);
  // Parallel + per-send 10s cap (P2.6): one hung push service must not
  // serialize/stall the whole notification fan-out (this runs inline in
  // event handlers). Sub count is tiny (one row per browser), so plain
  // allSettled is bounded enough — no need for a concurrency pool.
  const SEND_TIMEOUT_MS = 10_000;
  await Promise.allSettled(subs.map(async (s) => {
    const sub = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.authKey },
    };
    try {
      await Promise.race([
        webpush.sendNotification(sub as any, body, { TTL: 60 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('push send timeout')), SEND_TIMEOUT_MS)),
      ]);
      db.update(claudePushSubs)
        .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
        .where(eq(claudePushSubs.id, s.id)).run();
    } catch (e: any) {
      // 410 = endpoint gone, delete it
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        db.delete(claudePushSubs).where(eq(claudePushSubs.id, s.id)).run();
      }
    }
  }));
}
