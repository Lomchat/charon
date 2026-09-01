import { beforeEach, describe, expect, it } from 'vitest';
import { isSameWorkspace, normalizeWorkspacePath, workspaceScopeKey } from '@/app/workspaceScope';
import {
  __resetWorkspacePanelState,
  readWorkspacePanelScroll,
  readWorkspacePanelTab,
  writeWorkspacePanelScroll,
  writeWorkspacePanelTab,
} from '@/app/workspacePanelState';

describe('workspace scope', () => {
  beforeEach(() => __resetWorkspacePanelState());

  it('matches only the same VPS and normalized path', () => {
    const active = { vpsId: 'v1', path: '/srv/test/' };
    expect(isSameWorkspace(active, 'v1', '/srv/test')).toBe(true);
    expect(isSameWorkspace(active, 'v2', '/srv/test')).toBe(false);
    expect(isSameWorkspace(active, 'v1', '/srv/other')).toBe(false);
    expect(normalizeWorkspacePath('/')).toBe('/');
    expect(workspaceScopeKey('v1', '/srv/test/')).toBe(workspaceScopeKey('v1', '/srv/test'));
  });

  it('shares the panel tab and scroll position for one workspace', () => {
    writeWorkspacePanelTab('v1', '/srv/test', 'search');
    writeWorkspacePanelScroll('v1', '/srv/test', 'search', 184);
    expect(readWorkspacePanelTab('v1', '/srv/test/')).toBe('search');
    expect(readWorkspacePanelScroll('v1', '/srv/test/', 'search')).toBe(184);
    expect(readWorkspacePanelTab('v1', '/srv/other')).toBe('tree');
  });
});
