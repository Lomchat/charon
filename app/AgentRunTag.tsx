'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { shortModel } from './resumeHistory';

export type AgentRun = { model?: string | null; effort?: string | null };

/** What an agent runs on: its model, then its effort. */
export default function AgentRunTag({ model, effort }: AgentRun) {
  if (!model && !effort) return null;
  return <span className="bg-run">{model && <b>{shortModel(model)}</b>}{effort && <i>{effort}</i>}</span>;
}

/** One tag for several agents when they all run alike (a workflow lane). */
export function sharedRun(runs: AgentRun[]): AgentRun | null {
  const first = runs[0];
  if (!first?.model) return null;
  return runs.every((r) => r.model === first.model && (r.effort ?? null) === (first.effort ?? null)) ? first : null;
}

// Per session, for the page's life: an agent's model and effort do not change.
const known = new Map<string, ReadonlyMap<string, AgentRun>>();

/** Model + effort of the session's background agents, read from their
 *  transcripts by the hub. Asks only for the ids it has no answer for, and
 *  keeps asking (slower and slower) while one has not written a reply yet. */
export function useBgAgentRuns(sessionId: string, ids: string[], enabled: boolean): ReadonlyMap<string, AgentRun> {
  const [runs, setRuns] = useState<ReadonlyMap<string, AgentRun>>(() => known.get(sessionId) ?? new Map());
  const key = ids.join(',');
  useEffect(() => {
    if (!enabled || !key) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 5_000;
    const controller = new AbortController();
    const load = async () => {
      const have = known.get(sessionId) ?? new Map<string, AgentRun>();
      const missing = key.split(',').filter((id) => !have.has(id));
      if (!missing.length) { setRuns(have); return; }
      try {
        if (document.visibilityState === 'visible') {
          const result = await api.getAgentRunConfigs(sessionId, missing, controller.signal);
          if (stopped) return;
          if (result.ok && Object.keys(result.configs).length) {
            const next = new Map(known.get(sessionId) ?? []);
            for (const [id, run] of Object.entries(result.configs)) next.set(id, run);
            known.set(sessionId, next);
            setRuns(next);
          }
        }
      } catch { /* the tag is optional: try again later */ }
      if (!stopped) { timer = setTimeout(load, delay); delay = Math.min(delay * 2, 60_000); }
    };
    void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, key, enabled]);
  return runs;
}
