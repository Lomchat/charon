// Types partagés entre la vue desktop (ClaudePanel + composants) et la vue
// mobile (MobileChat). Avant ce fichier, chaque vue redéclarait les mêmes
// types localement (Msg, ToolCallEntry, Todo, EditSnapshot, PermissionRequest,
// PendingQuestion, PendingExitPlan) avec un commentaire "copié de…".
//
// Choix : `sessionId: string` requis partout. Côté mobile (single-session)
// on remplit avec le sessionId courant — coût mémoire négligeable, et ça
// simplifie le hook `useClaudeSessionStream` qui n'a pas à brancher sur
// deux shapes différentes.

export type Msg = {
  id: string;
  role: string;
  content: string;
  createdAt: number;
};

export type ToolCallEntry = {
  id: string;
  name: string;
  // `any` plutôt qu'`unknown` parce que les call sites accèdent à des
  // sous-champs polymorphes (file_path, content, command, todos…) sans
  // narrow systématique. Tightening implique un gros nettoyage hors scope.
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
  // Idem ToolCallEntry — `any` pour rester compat avec les call sites.
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
