// One-shot — import des données Claude depuis /srv/hub/data/hub.db.
// Exécuter une seule fois après la mise en route de heimdall.db (migration 0000).
// Idempotent grâce à `INSERT OR IGNORE` (PK conflict → skip).
//
// Usage: node /srv/heimdall/scripts/import-from-hub.mjs
import Database from 'better-sqlite3';

const HUB_DB = '/srv/hub/data/hub.db';
const HEIMDALL_DB = '/srv/heimdall/data/heimdall.db';

const dst = new Database(HEIMDALL_DB);
dst.pragma('foreign_keys = ON');
dst.exec(`ATTACH DATABASE '${HUB_DB}' AS src`);

function count(table) {
  return dst.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}
function srcCount(table) {
  return dst.prepare(`SELECT COUNT(*) AS c FROM src.${table}`).get().c;
}

const before = {
  vps: count('vps'),
  projects: count('projects'),
  claude_sessions: count('claude_sessions'),
  claude_session_messages: count('claude_session_messages'),
  claude_pending_permissions: count('claude_pending_permissions'),
  claude_pending_questions: count('claude_pending_questions'),
  claude_session_logs: count('claude_session_logs'),
  claude_settings: count('claude_settings'),
  claude_push_subscriptions: count('claude_push_subscriptions'),
  vps_project_paths: count('vps_project_paths')
};

const tx = dst.transaction(() => {
  // vps : copie complète des colonnes communes
  dst.exec(`
    INSERT OR IGNORE INTO vps (id, name, ip, ssh_user, ssh_port, default_path, created_at)
    SELECT id, name, ip, ssh_user, ssh_port, default_path, created_at FROM src.vps
  `);

  // projects : projection sur le sous-ensemble des colonnes heimdall
  dst.exec(`
    INSERT OR IGNORE INTO projects (id, name, glyph, color_token, url, created_at)
    SELECT id, name, glyph, color_token, url, created_at FROM src.projects
  `);

  // vps_project_paths : extraction depuis les block_items 'vps' du hub.
  // Les paths sont stockés dans block_items.meta (JSON) lié à un block de type='vps'.
  const vpsBlocks = dst.prepare(`SELECT id, project_id FROM src.blocks WHERE type = 'vps'`).all();
  const blockMap = new Map(vpsBlocks.map((b) => [b.id, b.project_id]));
  if (blockMap.size > 0) {
    const blockIds = [...blockMap.keys()];
    const placeholders = blockIds.map(() => '?').join(',');
    const items = dst.prepare(
      `SELECT block_id, meta FROM src.block_items WHERE block_id IN (${placeholders}) AND meta IS NOT NULL`
    ).all(...blockIds);
    const insert = dst.prepare(
      `INSERT OR IGNORE INTO vps_project_paths (vps_id, project_id, path) VALUES (?, ?, ?)`
    );
    for (const it of items) {
      let m;
      try { m = JSON.parse(it.meta); } catch { continue; }
      if (!m?.vpsId || !m?.path) continue;
      const projectId = blockMap.get(it.block_id);
      if (!projectId) continue;
      insert.run(m.vpsId, projectId, String(m.path));
    }
  }

  // Tables Claude — schémas identiques, copie ligne-à-ligne
  for (const table of [
    'claude_sessions',
    'claude_session_messages',
    'claude_pending_permissions',
    'claude_pending_questions',
    'claude_session_logs',
    'claude_settings',
    'claude_push_subscriptions'
  ]) {
    dst.exec(`INSERT OR IGNORE INTO ${table} SELECT * FROM src.${table}`);
  }
});

tx();

const after = {
  vps: count('vps'),
  projects: count('projects'),
  vps_project_paths: count('vps_project_paths'),
  claude_sessions: count('claude_sessions'),
  claude_session_messages: count('claude_session_messages'),
  claude_pending_permissions: count('claude_pending_permissions'),
  claude_pending_questions: count('claude_pending_questions'),
  claude_session_logs: count('claude_session_logs'),
  claude_settings: count('claude_settings'),
  claude_push_subscriptions: count('claude_push_subscriptions')
};

console.log('import terminé.');
console.log('comptes :');
for (const k of Object.keys(after)) {
  const b = before[k] ?? 0;
  const a = after[k];
  console.log(`  ${k.padEnd(28)} ${b} → ${a}   (src.${k}=${srcCount(k === 'vps_project_paths' ? 'block_items' : k)})`);
}

dst.close();
