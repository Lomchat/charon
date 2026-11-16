// Browser-local transcript presentation. OFF = conversation view: the session
// GET is asked for `view=conversation`; technical rows are neither fetched nor
// kept, while live tool/thinking frames still drive tool calls, files, edits,
// background tasks and the ThinkingBar (§14.25/§14.107).
import type { TranscriptView } from '@/lib/transcriptRows';

export const SHOW_TOOLS_STORAGE_KEY = 'hub.claude.showTools.v1';

const TECHNICAL_CHAT_ROLES = new Set([
  'tool_use',
  'tool_result',
  'thinking',
  'plan',
  // Historical control-plane cards already render as null, but keeping the
  // role here makes the clean-view contract explicit for old cached rows.
  'activity',
]);

export function shouldShowChatRole(role: string, showTools: boolean): boolean {
  return showTools || !TECHNICAL_CHAT_ROLES.has(role);
}

/** The transcript view the session GET is asked for. */
export function transcriptViewFor(showTools: boolean): TranscriptView {
  return showTools ? 'full' : 'conversation';
}

/** The stored preference (default ON; `'0'` = tools hidden). Browser only:
 *  without storage (privacy mode) the default applies. */
export function readShowToolsPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(SHOW_TOOLS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}
