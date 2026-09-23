'use client';

// Le placard d'une machine : la liste de ses robots endormis.
//
// Un robot endormi n'est plus debout dans la salle — il n'y a plus, au fond de
// chaque quai, qu'une armoire par machine. Ce modal est ce que l'armoire
// contient : les sessions que Charon déclare « sleeping », rangées par chemin
// de travail comme sa barre latérale range les siennes.
//
// Le rangement n'est pas réécrit ici. `sidebarPathGroups` est le fichier qui
// décide, côté Charon, ce qu'est « le même dossier » et dans quel ordre ses
// titres s'affichent ; le desk importe les mêmes deux fonctions. Le placard et
// la barre latérale ne peuvent donc pas diverger — et le style vient des mêmes
// classes (`cs-path-*`), celles de la barre latérale, que `claude.css` publie
// déjà sur cette page.
//
// Il ne fait qu'une chose de plus : ouvrir. Chaque ligne ouvre la session
// comme le ferait un clic sur un robot — le même modal, la même vue de session,
// avec la liste qui reste derrière et reprend la main à la fermeture.

import { useEffect, useMemo, useState } from 'react';
import type { Vps } from '@/lib/types/api';
import type { DeskSession } from '../hall/palette';
import { detourOf, familyOf, robotName } from '../hall/palette';
import { sidebarPathKey, sidebarPathOrderedIds } from '@/app/sidebarPathGroups';
import { ago } from './time';

type Props = {
  vps: Vps;
  /** Les robots endormis de cette machine, dans l'ordre de Charon. */
  asleep: DeskSession[];
  /** Vrai quand une session est ouverte PAR-DESSUS : le placard reste en place,
   *  mais il ne capte plus ni les clics ni la touche d'échappement. */
  covered: boolean;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
};

export default function StoreModal({ vps, asleep, covered, onOpenSession, onClose }: Props) {
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (covered) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [covered, onClose]);

  /**
   * Les groupes du placard : un chemin, ses dormants, dans l'ordre de Charon.
   *
   * `sidebarPathOrderedIds` rend exactement la suite de ses cartes une fois
   * qu'elle les a groupées par chemin — le placard la relit dans l'ordre, et
   * ouvre un titre chaque fois que le chemin change. Rien n'est retrié : un
   * robot garde, ici comme là-bas, le rang que Charon lui donne.
   */
  const groups = useMemo(() => {
    const byId = new Map(asleep.map((session) => [session.id, session]));
    const out: { path: string; sessions: DeskSession[] }[] = [];
    for (const id of sidebarPathOrderedIds(asleep.map((s) => ({ id: s.id, cwd: s.cwd })))) {
      const session = byId.get(id);
      if (!session) continue;
      const path = sidebarPathKey(session.cwd);
      let group = out.find((candidate) => candidate.path === path);
      if (!group) {
        group = { path, sessions: [] };
        out.push(group);
      }
      group.sessions.push(session);
    }
    return out;
  }, [asleep]);

  const families = [...new Set(asleep.map((s) => familyOf(s.kind).id))];

  const toggle = (path: string) => {
    setShut((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="dsk-modal" role="dialog" aria-modal="true" aria-label={`${vps.name} storage`}>
      <div className="dsk-veil" onClick={onClose} />

      <div className="dsk-frame dsk-store">
        <header className="dsk-frame-head">
          <span className="who">{vps.name}</span>
          <span className="where">{vps.ip}</span>
          <span className="where">{vps.defaultPath}</span>
          <span className="state" style={{ color: '#3f6ea8' }}>
            <i style={{ animation: 'none' }} />
            {asleep.length} asleep
          </span>
          <span className="spacer" />
          <span className="dsk-families">
            {families.map((id) => {
              const family = familyOf(id);
              return (
                <span key={id} className="dsk-chip">
                  {family.logo && <img src={family.logo} alt="" width={13} height={13} />}
                  <i style={{ background: family.css }} />
                  {family.label}
                </span>
              );
            })}
          </span>
          <button type="button" onClick={onClose} aria-label="Close">Close</button>
        </header>

        <div className="dsk-store-body">
          <p className="dsk-store-note">
            Stored here, grouped by working directory the way Charon’s sidebar groups
            them. Open one and it wakes up in Charon — the desk only reads.
          </p>
          <ul className="dsk-store-list">
            {groups.map((group) => {
              const collapsed = shut.has(group.path);
              const label = group.path === '~' ? 'default home directory' : group.path;
              return (
                <li key={group.path} className="cs-path-group">
                  <button
                    type="button"
                    className="cs-path-head"
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? 'expand' : 'collapse'} path ${group.path}`}
                    title={label}
                    onClick={() => toggle(group.path)}
                  >
                    <span className="cs-caret" aria-hidden>{collapsed ? '▸' : '▾'}</span>
                    <span className="cs-path-mark" aria-hidden />
                    <span className="cs-path-name">{group.path}</span>
                    <span className="cs-path-count">{group.sessions.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="dsk-store-rows">
                      {group.sessions.map((session) => {
                        const family = familyOf(session.kind);
                        const detour = detourOf(session);
                        return (
                          <button
                            key={session.id}
                            type="button"
                            className="dsk-store-row"
                            onClick={() => onOpenSession(session.id)}
                          >
                            {family.logo
                              ? <img className="logo" src={family.logo} alt="" width={24} height={24} />
                              : <span className="logo" style={{ background: family.css }} />}
                            <span className="who">
                              {robotName(session)}
                              {session.name && `@${session.handle ?? ''}` !== session.name && (
                                <em>{session.name}</em>
                              )}
                            </span>
                            {detour && <span className="tag" style={{ color: family.css }}>{detour.label}</span>}
                            <span className="when">{ago(session.lastActivityMs)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
