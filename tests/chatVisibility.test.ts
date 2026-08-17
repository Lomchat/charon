import { describe, expect, it } from 'vitest';
import { shouldShowChatRole } from '@/app/chatVisibility';

describe('conversation-only transcript filter', () => {
  it('keeps the historical full transcript when show tools is enabled', () => {
    for (const role of ['user', 'assistant', 'tool_use', 'tool_result', 'thinking', 'plan']) {
      expect(shouldShowChatRole(role, true)).toBe(true);
    }
  });

  it('hides technical activity when show tools is disabled', () => {
    for (const role of ['tool_use', 'tool_result', 'thinking', 'plan', 'activity']) {
      expect(shouldShowChatRole(role, false)).toBe(false);
    }
  });

  it('keeps dialogue, generated output and context boundaries', () => {
    for (const role of ['user', 'assistant', 'external', 'structured', 'compaction', 'forkpoint']) {
      expect(shouldShowChatRole(role, false)).toBe(true);
    }
  });
});
