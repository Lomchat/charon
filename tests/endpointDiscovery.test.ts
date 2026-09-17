import { describe, expect, it } from 'vitest';
import { endpointCatalog } from '@/lib/endpointDiscovery';

describe('explicit endpoint catalog routes', () => {
  it('recognizes the documented provider base, including a pasted inference URL', () => {
    for (const url of ['https://openrouter.ai/api', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/responses', 'https://OPENROUTER.AI:443/api/']) {
      expect(endpointCatalog(url)).toMatchObject({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api', modelsPath: '/v1/models' });
    }
    expect(endpointCatalog('https://opencode.ai/zen/go/v1/messages')?.name).toBe('OpenCode Go');
    expect(endpointCatalog('https://opencode.ai/zen/v1')?.name).toBe('OpenCode Zen');
  });
  it('never guesses for fal, self-hosted servers, another path, protocol, port or a lookalike', () => {
    for (const url of ['https://fal.run/openrouter/router/openai', 'http://localhost:8000', 'https://models.example.com',
      'https://openrouter.ai', 'https://openrouter.ai/v1', 'https://openrouter.ai/api/other', 'http://openrouter.ai/api',
      'https://openrouter.ai:8443/api', 'https://openrouter.ai.example/api', 'https://user@openrouter.ai/api',
      'https://openrouter.ai/api?key=secret', 'https://openrouter.ai/api#x', 'https://opencode.ai/other', 'not a url']) {
      expect(endpointCatalog(url), url).toBeUndefined();
    }
  });
});
