// Types for the chat view (HubPanel + SessionView +
import type { SessionProvider } from '@/lib/sessionCapabilities';
import type { PermissionSuggestion } from '@/lib/permissionSuggestions';
// useSessionStream). Before this file, the desktop and the old separate
// mobile view each redeclared the same types locally (Msg, ToolCallEntry,
// EditSnapshot, PermissionRequest, PendingQuestion, PendingExitPlan)
// with a "copied from..." comment; the mobile view has since been folded into
// the responsive `/` (CLAUDE.md §11).
//
// Choice: `sessionId: string` required everywhere. The single-session hook
// fills it with the current sessionId — negligible memory cost, and it
// simplifies the `useSessionStream` hook which doesn't have to branch
// on two different shapes.

export type Msg = {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  // Thinking deltas share one bubble until another message or a turn end.
  // Absent for complete SDK/imported reasoning blocks.
  thinkingDelta?: boolean;
  thinkingClosed?: boolean;
  // role='assistant' only: the model id Anthropic ACTUALLY served this message
  // with (session_messages.model, stamped server-side from the agent's
  // effective_model event). Rendered as a small chip in the bubble header —
  // API truth, immune to the model's own (unreliable) self-identification.
  // Null/undefined on other roles and on rows persisted before the feature.
  model?: string | null;
  // 0 = intermediate assistant text, 1 = this turn's final answer;
  // null/absent = legacy or imported message with unknown classification.
  assistantFinal?: number | null;
  // Final assistant rows: the turn's prompt-cache ledger (lib/promptCache.ts),
  // rendered in the bubble header. Absent on turns before the feature.
  turnUsage?: import('@/lib/promptCache').TurnLedger | null;
  // role='external' only: the addressable name of the session that sent this
  // message. Rendered as a chip beside the role, the same way an assistant
  // bubble shows the model that produced it.
  from?: string | null;
  fromProvider?: SessionProvider | null;
  sourceSessionId?: string | null;
  origin?: string | null;
  expectsReply?: boolean | null;
  messageId?: string | null;
  conversationId?: string | null;
  replyTo?: string | null;
  peerStatus?: 'accepted' | 'processing' | 'replied' | 'failed' | 'timed_out' | null;
  peerTarget?: string | null;
  peerTargetSessionId?: string | null;
  peerError?: string | null;
};

export type PlanStep = { step: string; status: string };

export type ToolCallEntry = {
  id: string;
  name: string;
  // `any` rather than `unknown` because the call sites access polymorphic
  // sub-fields (file_path, content, command, pattern...) without systematic
  // narrowing. Tightening implies a big cleanup out of scope.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  result?: { content: string; isError: boolean };
  startedAt: number;
};

export type EditSnapshot = {
  toolUseId: string;
  filePath: string;
  before: string | null;
  after: string | null;
  truncated: boolean;
};

export type PermissionRequest = {
  id: string;
  sessionId: string;
  tool: string;
  // Same as ToolCallEntry — `any` to remain compatible with the call sites.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  createdAt: number;
  // Unix seconds. The provider keeps running without a browser, but closes
  // the gate at this deadline if nobody answers.
  expiresAt?: number;
  /** The provider's own words for why it asks. */
  reason?: string;
  /** Claude: the CLI's "don't ask again" options (lib/permissionSuggestions.ts). */
  suggestions?: PermissionSuggestion[];
};

export type QuestionOption = { label: string; description?: string };
export type QuestionItem = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
};

export type PendingQuestion = {
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt?: number;
  questions: QuestionItem[];
  delivery?: 'async';
  // An async answer's send is in flight NOW (the session GET's
  // `pendingQuestions[].delivering`, in-memory hub side): the strip shows
  // "sending…", disabled. A failed send clears it (the form is usable again).
  delivering?: boolean;
};

export type PendingExitPlan = {
  id: string;
  sessionId: string;
  createdAt: number;
  expiresAt?: number;
  plan: string;
};
