// Browser-local transcript presentation. This never changes what the hub
// receives or stores: switching the technical activity off is only a render
// filter, so tool results still feed edits, background tasks and replay.
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
