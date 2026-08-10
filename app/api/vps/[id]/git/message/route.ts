import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { requireApiSession } from '@/lib/server/session';
import { getSetting } from '@/lib/server/claude/settings';
import { getGitDiff, getGitStatus } from '@/lib/server/claude/git';
import type { GitMessageResponse } from '@/lib/types/api';

// POST /api/vps/[id]/git/message  { cwd, paths[] | all }
//
// Draft a commit message for the selected changes — the ✨ button in the git
// tab. This is the one place in the panel that spends money, and the one thing
// a plain `git` client cannot do.
//
// It runs HUB-side against `claude.api_key` rather than through the session's
// own model: asking the running session would pollute the transcript and wake
// a sleeping one, and the OAuth token the sessions use cannot call
// api.anthropic.com anyway (§14.43 — verified, don't re-test).
//
// Two things make the output actually usable instead of generic:
//  - the repo's own last few commit subjects go in the prompt, so the draft
//    matches the local convention (scope, mood, length) rather than a
//    textbook one. They cost one extra `git log` and are fetched ONLY here.
//  - real diff hunks, not just filenames — a message written from a file list
//    can only ever restate the file list.
const MODEL = 'claude-opus-5';
// Bounded on purpose: this is a summary task, and a 400-file changeset would
// otherwise cost more than the commit is worth. The prompt says the sample was
// truncated so the model doesn't overstate its coverage.
const MAX_FILES_DIFFED = 20;
const MAX_TOTAL_DIFF_CHARS = 60_000;
const MAX_PER_FILE_CHARS = 12_000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const { id } = await params;
  const [v] = db.select().from(vps).where(eq(vps.id, id)).all();
  if (!v) return NextResponse.json({ error: 'vps not found' }, { status: 404 });

  let cwd = '';
  let paths: string[] = [];
  let all = false;
  try {
    const body = await req.json();
    cwd = String(body?.cwd ?? '');
    paths = Array.isArray(body?.paths) ? body.paths.map(String) : [];
    all = !!body?.all;
  } catch { /* empty */ }
  if (!cwd) return NextResponse.json({ ok: false, error: 'cwd required' }, { status: 400 });

  const apiKey = getSetting('claude.api_key');
  if (!apiKey) {
    return NextResponse.json<GitMessageResponse>({
      ok: false,
      error: 'no API key — add claude.api_key in Settings to draft commit messages',
    });
  }

  const status = await getGitStatus(id, cwd, { includeRecent: true });
  if (!status.ok || !status.isRepo) {
    return NextResponse.json<GitMessageResponse>({
      ok: false, error: status.error || 'not a git repository',
    });
  }
  const selected = all
    ? status.files
    : status.files.filter((f) => paths.includes(f.path));
  if (selected.length === 0) {
    return NextResponse.json<GitMessageResponse>({ ok: false, error: 'no files selected' });
  }

  // Diffs one file at a time (the only shape the agent exposes — §14.41), in
  // selection order, until the budget runs out. Sequential rather than
  // parallel: each is a git subprocess on the VPS and the whole point is to
  // stay cheap next to the model call that follows.
  const parts: string[] = [];
  let budget = MAX_TOTAL_DIFF_CHARS;
  let diffed = 0;
  for (const f of selected.slice(0, MAX_FILES_DIFFED)) {
    if (budget <= 0) break;
    if (f.binary) continue;
    const d = await getGitDiff(id, cwd, f.path);
    if (!d.ok || !d.patch) continue;
    const patch = d.patch.length > MAX_PER_FILE_CHARS
      ? d.patch.slice(0, MAX_PER_FILE_CHARS) + '\n… (diff truncated)\n'
      : d.patch;
    parts.push(patch);
    budget -= patch.length;
    diffed++;
  }

  const fileList = selected
    .map((f) => `${f.status} ${f.path}${f.added != null ? ` (+${f.added} −${f.deleted ?? 0})` : ''}`)
    .join('\n');
  const omitted = selected.length - diffed;
  const convention = (status.recentSubjects ?? []).length
    ? `Recent commit subjects from this repository — match their convention (prefix, scope, mood, length):\n${status.recentSubjects!.map((x) => `- ${x}`).join('\n')}`
    : 'No commit history available; use the Conventional Commits convention.';

  const prompt = [
    `Write the commit message for the change below, in the repository at ${status.root}.`,
    '',
    convention,
    '',
    `Files in this commit (${selected.length}):`,
    fileList,
    omitted > 0 ? `\n(${omitted} of these are not included in the diff sample below.)` : '',
    '',
    'Diff:',
    '```diff',
    parts.join('\n'),
    '```',
  ].join('\n');

  const client = new Anthropic({ apiKey });
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      // Short, scoped summarization: `low` keeps the ✨ button feeling
      // instant. Thinking stays at the Opus 5 default (on) — disabling it can
      // leak <thinking> tags into the visible answer, and this answer is
      // pasted verbatim into a commit.
      output_config: { effort: 'low' },
      system: [
        'You write git commit messages. Output ONLY the commit message — no preamble,',
        'no code fences, no commentary.',
        'A subject line under 72 characters, in the imperative mood, describing WHY the',
        'change was made rather than restating the diff. Then, only if the change genuinely',
        'needs it, a blank line and a short body of one to three lines.',
        'Never invent a ticket number, a co-author, or a rationale the diff does not support.',
      ].join('\n'),
      messages: [{ role: 'user', content: prompt }],
    });

    if (res.stop_reason === 'refusal') {
      return NextResponse.json<GitMessageResponse>({ ok: false, error: 'the model declined this diff' });
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      // Belt and braces: a fenced answer would otherwise be committed verbatim.
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();
    if (!text) return NextResponse.json<GitMessageResponse>({ ok: false, error: 'empty response' });
    return NextResponse.json<GitMessageResponse>({ ok: true, message: text });
  } catch (e: unknown) {
    // Typed SDK errors so the UI can say something actionable rather than
    // "request failed" — a bad key and a rate limit need different fixes.
    if (e instanceof Anthropic.AuthenticationError) {
      return NextResponse.json<GitMessageResponse>({ ok: false, error: 'the API key was rejected — check claude.api_key in Settings' });
    }
    if (e instanceof Anthropic.RateLimitError) {
      return NextResponse.json<GitMessageResponse>({ ok: false, error: 'rate-limited by the API — try again shortly' });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json<GitMessageResponse>({ ok: false, error: msg.slice(0, 200) });
  }
}
