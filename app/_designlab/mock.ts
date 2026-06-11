// Shared fake data for the sidebar design explorations (/v1, /v2, /v3).
// Pure mock — none of this is wired to the real API. The goal is only to
// evaluate the LOOK of a "active sessions/shells only + new-entity modal"
// sidebar, not behaviour.

export type MockStatus =
  | 'active'
  | 'thinking'
  | 'starting'
  | 'sleeping'
  | 'waiting'; // active + pending permission

export type MockFolder = { id: string; name: string };

export type MockVps = {
  id: string;
  name: string;
  ip: string;
  host: string;
  folderId: string;
  agentStatus: 'ok' | 'error' | 'missing';
  agentVersion?: string;
  outdated?: boolean;       // ok agent but a newer .pyz exists → "update"
  loggedIn?: boolean;       // false → show "claude login"
  installing?: boolean;     // an install session is currently running
  paths: { label: string; path: string }[];
};

// VPS folders (sidebar organisation). 'default' = "No folder", always last.
export const MOCK_FOLDERS: MockFolder[] = [
  { id: 'prod', name: 'Production' },
  { id: 'perso', name: 'Personal' },
  { id: 'clients', name: 'Clients' },
  { id: 'default', name: 'No folder' },
];

export type MockSession = {
  id: string;
  vpsId: string;
  vpsName: string;
  name: string;
  cwd: string;
  status: MockStatus;
  preview: string;
  age: string;
  pendingPermissions?: number;
  color?: string; // css color for the left stripe
};

export type MockShell = {
  id: string;
  vpsId: string;
  vpsName: string;
  name: string | null;
  cwd: string;
  busy?: boolean;
  exited?: boolean;
  age: string;
  color?: string;
};

export const MOCK_VPS: MockVps[] = [
  {
    id: 'chalco', name: 'chalco', ip: '10.0.0.4', host: 'root@10.0.0.4',
    folderId: 'perso', agentStatus: 'ok', agentVersion: '0.10.1', loggedIn: true,
    paths: [
      { label: 'charon', path: '/srv/charon' },
      { label: 'root', path: '/root' },
    ],
  },
  {
    id: 'hetzner', name: 'hetzner-fsn1', ip: '159.69.12.8', host: 'deploy@159.69.12.8',
    folderId: 'prod', agentStatus: 'ok', agentVersion: '0.9.0', loggedIn: true, outdated: true,
    paths: [
      { label: 'blog', path: '/var/www/blog' },
      { label: 'api', path: '/srv/api' },
    ],
  },
  {
    id: 'ovh', name: 'ovh-gra', ip: '51.83.40.2', host: 'root@51.83.40.2',
    folderId: 'prod', agentStatus: 'ok', agentVersion: '0.10.1', loggedIn: false,
    paths: [
      { label: 'etl', path: '/opt/etl' },
      { label: 'nginx', path: '/etc/nginx' },
    ],
  },
  {
    id: 'contabo', name: 'contabo-eu', ip: '161.97.0.10', host: 'root@161.97.0.10',
    folderId: 'clients', agentStatus: 'error', agentVersion: '0.10.0',
    paths: [{ label: 'home', path: '/root' }],
  },
  {
    id: 'do-nyc', name: 'do-nyc1', ip: '142.93.0.20', host: 'root@142.93.0.20',
    folderId: 'default', agentStatus: 'missing',
    paths: [],
  },
  {
    id: 'nas-home', name: 'nas-home', ip: '192.168.1.20', host: 'root@192.168.1.20',
    folderId: 'default', agentStatus: 'missing', installing: true,
    paths: [],
  },
];

export const MOCK_SESSIONS: MockSession[] = [
  {
    id: 's1', vpsId: 'chalco', vpsName: 'chalco', name: 'sidebar redesign',
    cwd: '/srv/charon', status: 'thinking',
    preview: 'refactor the sidebar to only show active sessions and shells…',
    age: '2min', color: '#8ab4e4',
  },
  {
    id: 's2', vpsId: 'hetzner', vpsName: 'hetzner-fsn1', name: 'blog deploy',
    cwd: '/var/www/blog', status: 'waiting', pendingPermissions: 1,
    preview: 'run the production build and push to the CDN bucket',
    age: '5min', color: '#d8a85a',
  },
  {
    id: 's3', vpsId: 'ovh', vpsName: 'ovh-gra', name: 'etl pipeline',
    cwd: '/opt/etl', status: 'active',
    preview: 'add retry logic around the postgres COPY step',
    age: '12min',
  },
  {
    id: 's4', vpsId: 'ovh', vpsName: 'ovh-gra', name: 'nginx tuning',
    cwd: '/etc/nginx', status: 'starting',
    preview: 'tighten the tls config and enable http/3',
    age: 'just now', color: '#86c5d8',
  },
  {
    id: 's5', vpsId: 'hetzner', vpsName: 'hetzner-fsn1', name: 'api migration',
    cwd: '/srv/api', status: 'sleeping',
    preview: 'migrate the auth module from sessions to JWT',
    age: '3h',
  },
  {
    id: 's6', vpsId: 'chalco', vpsName: 'chalco', name: 'scratch',
    cwd: '/root', status: 'sleeping',
    preview: 'quick one-off — inspect the disk usage on / and report',
    age: '1d', color: '#a8b8e0',
  },
];

export const MOCK_SHELLS: MockShell[] = [
  {
    id: 'sh1', vpsId: 'chalco', vpsName: 'chalco', name: null,
    cwd: '/srv/charon', busy: true, age: '8min',
  },
  {
    id: 'sh2', vpsId: 'hetzner', vpsName: 'hetzner-fsn1', name: 'logs',
    cwd: '/var/log', age: '40min', color: '#d8757f',
  },
  {
    id: 'sh3', vpsId: 'ovh', vpsName: 'ovh-gra', name: 'db backup',
    cwd: '/opt/etl', exited: true, age: '2h',
  },
];

export const STATUS_DOT: Record<MockStatus, string> = {
  active: 'dot-green',
  thinking: 'dot-amber-pulse',
  starting: 'dot-amber',
  sleeping: 'dot-gray',
  waiting: 'dot-orange-pulse',
};

export const STATUS_LABEL: Record<MockStatus, string> = {
  active: 'ready',
  thinking: 'working',
  starting: 'starting',
  sleeping: 'sleeping',
  waiting: 'needs you',
};

export function cwdTail(cwd: string, max = 34): string {
  return cwd.length > max ? '…' + cwd.slice(-(max - 1)) : cwd;
}

export function folderName(id: string): string {
  return MOCK_FOLDERS.find((f) => f.id === id)?.name ?? id;
}

// A VPS that needs the user's attention (so it should appear in the sidebar
// even with no open session/shell): agent missing/error/installing, an
// available update, or not signed in to Claude.
export function vpsNeedsAttention(v: MockVps): boolean {
  return v.agentStatus !== 'ok' || !!v.outdated || !!v.installing || v.loggedIn === false;
}

// Bucket per-VPS groups into their folders, in MOCK_FOLDERS order,
// keeping only folders that actually contain a VPS in `groups`.
export function bucketByFolder<T extends { vps: MockVps }>(groups: T[]) {
  return MOCK_FOLDERS
    .map((folder) => ({ folder, groups: groups.filter((g) => g.vps.folderId === folder.id) }))
    .filter((b) => b.groups.length > 0);
}
