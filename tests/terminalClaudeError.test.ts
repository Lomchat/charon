import { describe, expect, it } from 'vitest';
import { classifyTerminalClaudeError } from '../lib/terminalClaudeError';
import { SYNTHETIC_MODEL } from '../lib/turnInterrupted';

describe('classifyTerminalClaudeError', () => {
  it('classifies synthetic and legacy API errors', () => {
    expect(classifyTerminalClaudeError(
      'API Error: 529 {"type":"overloaded_error"}',
      SYNTHETIC_MODEL,
    )).toBe('api');
    expect(classifyTerminalClaudeError(
      'API Error: Connection closed mid-response. The response above may be incomplete.',
    )).toBe('api');
    expect(classifyTerminalClaudeError('API Error: 500 Internal Server Error')).toBe('api');
  });

  it('classifies authentication failures', () => {
    expect(classifyTerminalClaudeError(
      'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
    )).toBe('authentication');
    expect(classifyTerminalClaudeError('Authentication failed: credentials were rejected.'))
      .toBe('authentication');
    expect(classifyTerminalClaudeError('Unauthorized: please sign in again.'))
      .toBe('authentication');
  });

  it('does not classify quoted, fenced, long, or ordinary prose', () => {
    expect(classifyTerminalClaudeError('> API Error: 500 Internal Server Error')).toBeNull();
    expect(classifyTerminalClaudeError('```\nAPI Error: 500 Internal Server Error\n```', SYNTHETIC_MODEL))
      .toBeNull();
    expect(classifyTerminalClaudeError(
      'I handled the API Error from the upstream service and the retry succeeded.',
    )).toBeNull();
    expect(classifyTerminalClaudeError(`API Error: ${'x'.repeat(700)}`, SYNTHETIC_MODEL))
      .toBeNull();
  });
});
