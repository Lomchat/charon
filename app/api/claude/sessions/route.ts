import { NextResponse } from 'next/server';
import { desc, eq, and, sql } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable, claudePendingPermissions, claudePendingQuestions } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { startNewSession, listStreams } from '@/lib/server/agent/sessionOps';
import { cliNamesForVps } from '@/lib/server/claude/cliNames';
import { focusCountFor } from '@/lib/server/agent/eventConnections';
import { getBuiltPyzSha, getBuiltAgentVersion } from '@/lib/server/agent/builtPyzSha';
import { getSdkLatestVersion, getCodexLatestVersion, getCodexCliLatestVersion } from '@/lib/server/claude/sdkSync';
import type { AgentKind, CodexSessionConfig } from '@/lib/types/api';
import type { SessionMode } from '@/lib/server/agent/types';

// GET /api/claude/sessions
// Query: ?vpsId= ?status=
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  try {
    const url = new URL(req.url);
    const filters: any[] = [];
    const vpsId = url.searchParams.get('vpsId');
    const status = url.searchParams.get('status');
    const includeArchived = url.searchParams.get('includeArchived') === '1';
    if (vpsId) filters.push(eq(claudeSessions.vpsId, vpsId));
    if (status) filters.push(eq(claudeSessions.status, status));
    if (!includeArchived) filters.push(eq(claudeSessions.archived, 0));
    const where = filters.length ? and(...filters) : undefined;
    const rows = db.select().from(claudeSessions)
      .where(where as any)
      .orderBy(desc(claudeSessions.createdAt), desc(claudeSessions.id))
      .all();

    // Annotate with live status + subs count + pendingPermissions
    const streams = new Map(listStreams().map((s) => [s.id, s] as const));
    const pendingRows = db.select({
      sessionId: claudePendingPermissions.sessionId,
      n: sql<number>`count(*)`.as('n'),
    })
      .from(claudePendingPermissions)
      .where(eq(claudePendingPermissions.status, 'pending'))
      .groupBy(claudePendingPermissions.sessionId)
      .all();
    const pendingBySession = new Map(pendingRows.map((r) => [r.sessionId, Number(r.n)] as const));
    const pendingQRows = db.select({
      sessionId: claudePendingQuestions.sessionId,
      n: sql<number>`count(*)`.as('n'),
    })
      .from(claudePendingQuestions)
      .where(eq(claudePendingQuestions.status, 'pending'))
      .groupBy(claudePendingQuestions.sessionId)
      .all();
    const pendingQBySession = new Map(pendingQRows.map((r) => [r.sessionId, Number(r.n)] as const));

    const firstMsgRows = db.all(sql`
      SELECT session_id as sessionId, content
      FROM claude_session_messages
      WHERE id IN (
        SELECT MIN(id) FROM claude_session_messages
        WHERE role = 'user'
        GROUP BY session_id
      )
    `) as Array<{ sessionId: string; content: string }>;
    const firstMsgBySession = new Map(firstMsgRows.map((r) => [r.sessionId, r.content] as const));

    // The ADDRESSABLE name each session really has, straight from the CLI.
    // One call per VPS (cached 60s), never per session. Unknown → the client
    // marks its @handle unconfirmed rather than presenting a guess as an
    // address (§14.93).
    const vpsIds = [...new Set(rows.map((r) => r.vpsId))];
    const cliNameByVps = new Map(await Promise.all(
      vpsIds.map(async (v) => [v, await cliNamesForVps(v)] as const)));

    const annotated = rows.map((r) => {
      const stream = streams.get(r.id);
      const perms = pendingBySession.get(r.id) ?? 0;
      const qs = pendingQBySession.get(r.id) ?? 0;
      const firstMsg = firstMsgBySession.get(r.id) ?? null;
      const cliName = cliNameByVps.get(r.vpsId)?.get(r.id) ?? null;
      return {
        ...r,
        codexConfig: undefined,
        liveStatus: stream ? stream.status : r.status,
        // What Claude itself calls this session. Null = not known (agent too
        // old, VPS offline, or session not running).
        cliName,
        // Codex thread names are persistent display identities, not peer
        // addresses. Claude is addressable only when the live CLI confirms
        // the peer name; a derived guess must never enter the @ menu.
        addressable: r.kind !== 'codex' && !!cliName,
        subscribers: focusCountFor(r.id),
        pendingPermissions: perms + qs,
        firstUserMessage: firstMsg ? firstMsg.slice(0, 180) : null,
      };
    });
    return NextResponse.json({
      sessions: annotated,
      // Live staleness baselines. These were SSR-only props before: a
      // long-open tab kept comparing vps.agentPyzSha against a FROZEN
      // builtPyzSha, so after a hub deploy + fleet auto-update every tab
      // showed a phantom "update agent" until F5. The client refreshes them
      // from this poll (15s + on every session_list_changed).
      meta: {
        builtPyzSha: getBuiltPyzSha(),
        builtAgentVersion: getBuiltAgentVersion(),
        sdkLatestVersion: getSdkLatestVersion(),
        codexLatestVersion: getCodexLatestVersion(),
        codexCliLatestVersion: getCodexCliLatestVersion(),
      },
    });
  } catch (e: any) {
    // Never let a transient DB hiccup surface as an unhandled 500 (which
    // returns an HTML error page that breaks the client's JSON parsing and
    // can cascade into a "stuck" UI). Log the real cause, return a clean,
    // retryable 503 — the client's 5s poll / sidebar refresh will retry.
    // eslint-disable-next-line no-console
    console.error('[api/claude/sessions GET] failed:', e?.stack ?? e);
    return NextResponse.json({ error: e?.message ?? String(e), sessions: [] }, { status: 503 });
  }
}

function normalizeCodexConfig(raw: unknown): CodexSessionConfig | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('codexConfig must be an object');
  const r = raw as Record<string, unknown>;
  const text = (value: unknown, max: number) => typeof value === 'string'
    ? value.trim().slice(0, max) || null : null;
  const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
    typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
  const configOverrides = Array.isArray(r.configOverrides)
    ? r.configOverrides.filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim()).filter(Boolean).slice(0, 64).map((v) => v.slice(0, 2048))
    : [];
  const env: Record<string, string> = {};
  if (r.env && typeof r.env === 'object' && !Array.isArray(r.env)) {
    for (const [key, value] of Object.entries(r.env).slice(0, 64)) {
      if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && typeof value === 'string') env[key] = value.slice(0, 8192);
    }
  }
  let outputSchema: Record<string, unknown> | null = null;
  if (r.outputSchema != null) {
    if (typeof r.outputSchema !== 'object' || Array.isArray(r.outputSchema)) throw new Error('outputSchema must be a JSON object');
    if (JSON.stringify(r.outputSchema).length > 32_768) throw new Error('outputSchema is too large');
    outputSchema = r.outputSchema as Record<string, unknown>;
  }
  return {
    configOverrides, outputSchema,
    baseInstructions: text(r.baseInstructions, 32_768),
    developerInstructions: text(r.developerInstructions, 32_768),
    summary: pick(r.summary, ['auto', 'concise', 'detailed', 'none'] as const),
    personality: pick(r.personality, ['friendly', 'pragmatic', 'none'] as const),
    serviceTier: pick(r.serviceTier, ['fast', 'flex'] as const),
    ephemeral: r.ephemeral === true,
    modelProvider: text(r.modelProvider, 256), env,
    codexBin: text(r.codexBin, 4096),
    approvalsReviewer: pick(r.approvalsReviewer, ['user', 'auto_review'] as const) ?? 'user',
    permissionProfile: text(r.permissionProfile, 256),
  };
}

// POST /api/claude/sessions
// Body: { vpsId, cwd, name?, kind?, permissionMode?, model?, fallbackModel?, effort? }
export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  const vpsId = String(body.vpsId ?? '').trim();
  const cwd = String(body.cwd ?? '').trim();
  if (!vpsId || !cwd) {
    return NextResponse.json({ error: 'vpsId, cwd required' }, { status: 400 });
  }
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  // Agent-type discriminator (multi-agent). A Codex session needs the VPS to
  // actually run Codex (openai-codex importable, agent >= 0.15.0) — reject
  // early with a clear message otherwise (codexAvailable is 1 when available).
  const kind: AgentKind = body.kind === 'codex' ? 'codex' : 'claude';
  if (kind === 'codex' && v.codexAvailable !== 1) {
    return NextResponse.json(
      { error: 'Codex is not available on this VPS (agent < 0.15.0 or the openai-codex SDK is not installed).' },
      { status: 400 },
    );
  }

  // Kind-aware mode validation + default. Claude: a PermissionMode (default
  // 'auto'). Codex: a sandbox level (default 'workspace-write'). Codex has NO
  // human-approval mode — the "mode" is the sandbox guardrail.
  const CLAUDE_MODES = ['normal', 'acceptEdits', 'auto', 'plan'] as const;
  const CODEX_MODES = ['read-only', 'workspace-write', 'full-access'] as const;
  const allowedModes: readonly string[] = kind === 'codex' ? CODEX_MODES : CLAUDE_MODES;
  const defaultMode = kind === 'codex' ? 'workspace-write' : 'auto';
  const permissionMode = (
    typeof body.permissionMode === 'string' && allowedModes.includes(body.permissionMode)
      ? body.permissionMode
      : defaultMode
  ) as SessionMode;
  // Normalize the per-session config. Empty strings → null so the default-
  // resolution path in startNewSession treats them as "inherit global default"
  // (claude.default_* or codex.default_*). Effort is forwarded as a raw string;
  // sessionOps validates it per-kind and silently drops invalid values
  // (consistent with the agent-side guard). fallbackModel is Claude-only.
  const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : null;
  const fallbackModel = typeof body.fallbackModel === 'string' && body.fallbackModel.length > 0
    ? body.fallbackModel : null;
  const effort = typeof body.effort === 'string' && body.effort.length > 0 ? body.effort : null;
  let codexConfig: CodexSessionConfig | null = null;
  try {
    codexConfig = kind === 'codex' ? normalizeCodexConfig(body.codexConfig) : null;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  try {
    const stream = await startNewSession({
      vpsId, cwd,
      name: body.name ? String(body.name) : null,
      kind,
      permissionMode,
      model, fallbackModel, effort, codexConfig,
    });
    return NextResponse.json({
      id: stream.id, kind: stream.kind, status: stream.status, claudeSessionId: stream.claudeSessionId,
      vpsId, cwd, name: stream.name, permissionMode: stream.permissionMode,
      model: stream.model, fallbackModel: stream.fallbackModel, effort: stream.effort,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
