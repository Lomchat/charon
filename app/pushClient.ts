// Client-side helpers for Web Push.
import { api } from '@/lib/api';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return window.btoa(bin);
}

export async function pushSupported(): Promise<boolean> {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

export async function pushCurrentEndpoint(): Promise<string | null> {
  if (!(await pushSupported())) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  const sub = await reg.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}

export async function pushSubscribe(): Promise<{ ok: boolean; reason?: string }> {
  if (!(await pushSupported())) return { ok: false, reason: 'unsupported' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, reason: 'permission denied' };
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const r: any = await api.pushVapidKey();
  if (!r?.publicKey) return { ok: false, reason: 'no VAPID key' };
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(r.publicKey) as BufferSource,
  });
  const p256 = sub.getKey('p256dh');
  const auth = sub.getKey('auth');
  if (!p256 || !auth) return { ok: false, reason: 'missing keys' };
  await api.pushSubscribe({
    endpoint: sub.endpoint,
    keys: { p256dh: bufferToBase64(p256), auth: bufferToBase64(auth) },
    userAgent: navigator.userAgent,
  });
  return { ok: true };
}

export async function pushUnsubscribe(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try { await api.pushUnsubscribe(sub.endpoint); } catch {}
  try { await sub.unsubscribe(); } catch {}
}
