export const AUTO_RESUME_PROMPT = 'The usage limit interrupted this session. The limit has now reset. Continue exactly where you left off.';
export const RESET_SAFETY_DELAY_MS = 2 * 60_000;

export type ScheduledResumeStatus = 'scheduled' | 'sending' | 'sent' | 'cancelled';
export type ScheduledResumePayload = {
  type: 'scheduled_resume';
  scheduleId: string;
  status: ScheduledResumeStatus;
  runAt: number;
  content: string;
  attempts: number;
  lastError: string | null;
  sentAt: number | null;
};

export function parseScheduledResume(value: string | null | undefined): ScheduledResumePayload | null {
  if (!value) return null;
  try {
    const p = JSON.parse(value) as Partial<ScheduledResumePayload>;
    if (p.type !== 'scheduled_resume' || typeof p.scheduleId !== 'string') return null;
    if (!['scheduled', 'sending', 'sent', 'cancelled'].includes(String(p.status))) return null;
    if (typeof p.runAt !== 'number' || !Number.isFinite(p.runAt) || typeof p.content !== 'string') return null;
    return {
      type: 'scheduled_resume', scheduleId: p.scheduleId,
      status: p.status as ScheduledResumeStatus, runAt: Math.round(p.runAt),
      content: p.content.slice(0, 16_000),
      attempts: Number.isInteger(p.attempts) ? Math.max(0, p.attempts!) : 0,
      lastError: typeof p.lastError === 'string' ? p.lastError.slice(0, 1000) : null,
      sentAt: typeof p.sentAt === 'number' && Number.isFinite(p.sentAt) ? Math.round(p.sentAt) : null,
    };
  } catch {
    return null;
  }
}
