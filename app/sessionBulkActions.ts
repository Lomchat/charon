export type SessionLifecycleLike = {
  status: string;
  liveStatus?: string | null;
};

const SLEEPABLE = new Set(['active', 'thinking', 'starting', 'failed', 'background']);
const RESUMABLE = new Set(['sleeping', 'error']);

export function sessionLifecycleStatus(session: SessionLifecycleLike): string {
  return session.liveStatus ?? session.status;
}

export function canSleepSession(session: SessionLifecycleLike): boolean {
  return SLEEPABLE.has(sessionLifecycleStatus(session));
}

export function canResumeSession(session: SessionLifecycleLike): boolean {
  return RESUMABLE.has(sessionLifecycleStatus(session));
}
