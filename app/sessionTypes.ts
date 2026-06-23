// Types for the chat view (ClaudePanel + ClaudeSessionView +
// useClaudeSessionStream). Before this file, the desktop and the old separate
// mobile view each redeclared the same types locally (Msg, ToolCallEntry,
// Todo, EditSnapshot, PermissionRequest, PendingQuestion, PendingExitPlan)
// with a "copied from..." comment; the mobile view has since been folded into
// the responsive `/` (CLAUDE.md §11).
//
// Choice: `sessionId: string` required everywhere. The single-session hook
// fills it with the current sessionId — negligible memory cost, and it
// simplifies the `useClaudeSessionStream` hook which doesn't have to branch
// on two different shapes.

export type Msg = {
  id: string;
  role: string;
  content: string;
  createdAt: number;
};

export type ToolCallEntry = {
  id: string;
  name: string;
  // `any` rather than `unknown` because the call sites access polymorphic
  // sub-fields (file_path, content, command, todos...) without systematic
  // narrowing. Tightening implies a big cleanup out of scope.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  result?: { content: string; isError: boolean };
  startedAt: number;
};

export type Todo = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
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
  questions: QuestionItem[];
};

export type PendingExitPlan = {
  id: string;
  sessionId: string;
  createdAt: number;
  plan: string;
};
