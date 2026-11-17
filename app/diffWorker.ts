// Off-thread unified diff for the Tools "edits" tab (ToolPanel § EditCard):
// a big file's diff takes tens of ms to seconds, which the page must not wait
// for. One request in, one patch out ('' when it failed).
import { createPatch } from 'diff';

type Ask = { id: number; filePath: string; before: string; after: string };

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<Ask>) => void) | null;
  postMessage(message: { id: number; patch: string }): void;
};

scope.onmessage = (ev) => {
  const { id, filePath, before, after } = ev.data;
  let patch = '';
  try { patch = createPatch(filePath, before, after, '', '', { context: 3 }); } catch { /* '' */ }
  scope.postMessage({ id, patch });
};
