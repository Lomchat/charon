'use client';

// Le desk : la salle, et la conversation qui s'ouvre dedans.
//
// ─── D'où viennent les données ────────────────────────────────────────────────
// Trois sources, dans cet ordre d'autorité :
//
//  1. `GET /api/claude/sessions` — la MÊME route que la barre latérale de
//     Charon. Elle rend les sessions annotées (statut vivant, permissions en
//     attente, dernier message). C'est le point de convergence : SSE peut
//     rater un événement, le sondage de 60 s rattrape.
//  2. Le flux SSE global — `subscribeAll`. Il porte les bascules de statut,
//     la marque « fini non lu », la liste des sessions qui change, l'état des
//     machines, et ce qui se dit entre robots. C'est ce qui rend la salle
//     vivante à la seconde.
//  3. Les accessoires du serveur (VPS, dossiers) — rendus en SSR par
//     `page.tsx`, puis rafraîchis par `vpsRuntime` à chaque sondage.
//
// Rien n'est inventé. Le desk ne fabrique ni session, ni état, ni message : il
// ne fait que poser dans l'espace ce que Charon raconte déjà.
//
// ─── Le sens de la dépendance ────────────────────────────────────────────────
// `app/desk/**` importe `@/app/**` et `@/lib/**`. L'inverse n'existe pas : pas
// un fichier de Charon ne mentionne le desk. C'est ce qui rend le desk
// « semi-indépendant » — il suit Charon, Charon l'ignore.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { setFocus, subscribeAll, subscribeReconnect } from '@/app/globalEventStream';
import ConfirmModal from '@/app/ConfirmModal';
import PromptModal from '@/app/PromptModal';
import SessionContextMenu from '@/app/SessionContextMenu';
import { canResumeSession, canSleepSession } from '@/app/sessionBulkActions';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsRuntimeSnapshot } from '@/lib/types/api';
import { World, type DeskModel } from './hall/world';
import { roomName, stateOf, type DeskAction, type DeskSession } from './hall/palette';
import Hud, { type Counts } from './ui/Hud';
import SessionModal from './ui/SessionModal';
import StoreModal from './ui/StoreModal';

const POLL_MS = 60_000;

type Props = { vpsList: Vps[]; folders: VpsFolder[] };

/** Le détail d'un appel d'outil, en une ligne lisible. */
function summarize(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description', 'notebook_path']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

function emptyCounts(): Counts {
  return {
    question: 0, unread: 0, working: 0, background: 0,
    ready: 0, broken: 0, reconnecting: 0, asleep: 0
  };
}

export default function Desk({ vpsList, folders }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<World | null>(null);
  const actionsRef = useRef(new Map<string, DeskAction>());

  const [sessions, setSessions] = useState<DeskSession[]>([]);
  const [vps, setVps] = useState<Vps[]>(vpsList);
  const [openId, setOpenId] = useState<string | null>(null);
  // Le placard ouvert : l'identifiant du VPS dont on regarde les robots
  // endormis. Il vit SOUS le modal de session — on ouvre un dormant, on le
  // referme, et la liste est toujours là.
  const [storeId, setStoreId] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [live, setLive] = useState(false);
  const [fresh, setFresh] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [onFloor, setOnFloor] = useState<number | null>(null);

  // Le menu du clic droit, et les deux dialogues qu'il ouvre (renommer,
  // supprimer). On n'y garde que des IDENTIFIANTS : à chaque rendu, la ligne
  // vivante est relue dans `sessions`, sinon le menu parlerait d'un robot tel
  // qu'il était au moment du clic — nom, état et permissions compris.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  /* --------------------------------------------------------------- la salle */

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const world = new World(stage, {
      onOpen: (id) => { setStoreId(null); setOpenId(id); },
      // Un placard de stockage ouvert : la liste, pas une session.
      onStore: (vpsId) => setStoreId(vpsId),
      // Le clic droit : le menu du robot visé, à l'endroit du clic. Dans le
      // vide, il n'ouvre rien — il referme celui qui était ouvert.
      onMenu: (session, x, y) => setMenu(session ? { id: session.id, x, y } : null),
    });
    world.onStats = setFps;
    // Ce que la salle a réellement posé au sol : les machines sans agent éveillé
    // n'y descendent pas, et l'habillage doit pouvoir le dire.
    world.onLayout = (next) => setOnFloor(next.quais.length);
    worldRef.current = world;
    // Surface de mise au point : la salle s'expose sous `window.desk` pour
    // qu'on puisse l'interroger depuis la console du navigateur — bornes,
    // quais, position des robots. Rien dans le code ne s'en sert, et elle
    // disparaît avec la page. C'est un outil, pas une API.
    (window as unknown as { desk?: World }).desk = world;
    world.start();
    return () => {
      delete (window as unknown as { desk?: World }).desk;
      world.dispose();
      worldRef.current = null;
    };
  }, []);

  // Le modèle descend dans la salle à chaque changement. `update` ne
  // reconstruit le hall que si sa FORME a bougé ; le reste du temps, il
  // remplace le récit que la boucle de rendu lit image par image.
  useEffect(() => {
    const model: DeskModel = { sessions, vps, folders };
    worldRef.current?.update(model, actionsRef.current);
  }, [sessions, vps, folders]);

  /* --------------------------------------------------------------- données */

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/claude/sessions', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.sessions) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      setSessions((previous) => {
        // Le détail de ce qui est en attente n'est pas dans la liste : il
        // n'arrive que par le flux, et seulement pour la session qu'on
        // regarde. On le reporte donc d'un sondage à l'autre plutôt que de le
        // perdre à chaque minute.
        const kinds = new Map(
          previous.filter((s) => s.pendingKinds).map((s) => [s.id, s.pendingKinds] as const)
        );
        return (payload.sessions as DeskSession[]).map((session) =>
          kinds.has(session.id) ? { ...session, pendingKinds: kinds.get(session.id) } : session
        );
      });
      if (Array.isArray(payload.vpsRuntime)) {
        const runtime = new Map((payload.vpsRuntime as VpsRuntimeSnapshot[]).map((r) => [r.id, r]));
        setVps((previous) => previous.map((row) => {
          const live = runtime.get(row.id);
          return live ? { ...row, ...live } : row;
        }));
      }
      setError(null);
      setLive(true);
      setFresh(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLive(false);
    }
  }, []);

  // Le pouls : un sondage à l'ouverture et toutes les minutes ensuite, jamais
  // dans un onglet caché — la salle n'a personne à qui parler.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const touch = useCallback(() => setFresh(0), []);
  useEffect(() => {
    const timer = setInterval(() => {
      setFresh((value) => (value == null ? value : value + 1));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  /* ------------------------------------------------------------------ flux */

  useEffect(() => {
    const patch = (id: string, change: (session: DeskSession) => DeskSession) => {
      setSessions((previous) => previous.map((s) => (s.id === id ? change(s) : s)));
    };

    /** Le compteur de ce qui attend, par nature. La liste de Charon n'en donne
     *  que la somme ; `interaction_resolved` la décrémente dans la bonne case. */
    const bump = (id: string, kind: 'permission' | 'question' | 'exit_plan', delta: number) => {
      patch(id, (session) => {
        const kinds = { ...(session.pendingKinds ?? {}) };
        if (delta > 0) kinds[kind] = true;
        else delete kinds[kind];
        return { ...session, pendingKinds: kinds };
      });
    };

    const remember = (id: string, action: DeskAction) => {
      actionsRef.current.set(id, { ...action, at: Date.now() });
    };

    const off = subscribeAll((event) => {
      // La liste elle-même a bougé : une session créée, importée ou supprimée,
      // d'ici ou d'un autre appareil. Charon l'annonce (`session_list_changed`,
      // `emitGlobalSessionListChanged` dans `sessionOps.ts`) et sa barre
      // latérale s'y recolle aussitôt. Sans ce cas, la salle attendait le
      // sondage des soixante secondes pour voir naître un robot — et une session
      // créée depuis le téléphone n'entrait qu'à la minute suivante. Le sondage
      // reste le filet, pour l'événement qui se perd.
      if (event.type === 'session_list_changed') {
        void refresh();
        return;
      }
      const id = (event as { sessionId?: string }).sessionId;
      if (!id) return;
      touch();
      switch (event.type) {
        case 'status':
          patch(id, (s) => ({ ...s, liveStatus: event.status }));
          break;
        case 'session_unread':
          patch(id, (s) => ({ ...s, unreadStop: event.unread ? 1 : 0 }));
          break;
        case 'permission_request':
          bump(id, 'permission', 1);
          remember(id, { kind: 'perm', tool: event.tool });
          break;
        case 'user_question':
          bump(id, 'question', 1);
          remember(id, { kind: 'question', detail: event.questions?.[0]?.question ?? '' });
          break;
        case 'exit_plan_request':
          bump(id, 'exit_plan', 1);
          remember(id, { kind: 'question', detail: event.plan?.slice(0, 160) ?? '' });
          break;
        case 'interaction_resolved':
          bump(id, event.kind, -1);
          break;
        case 'tool_use':
          remember(id, { kind: 'tool', tool: event.name, detail: summarize(event.input) });
          break;
        case 'assistant_text':
        case 'thinking':
        case 'user_echo':
        case 'external_message':
        case 'peer_message_status':
        case 'stop':
        case 'compaction':
        case 'bg_task':
        case 'error':
        case 'turn_error':
          // Ceux-là partagent une même forme : ils racontent « ce qui vient de
          // se passer ». On les traduit en un fait unique, que l'écran du robot
          // affiche tel quel.
          applyAction(id, event);
          break;
        default:
          break;
      }
    });

    function applyAction(id: string, event: {
      type: string; [key: string]: unknown;
    }) {
      switch (event.type) {
        case 'assistant_text': {
          // Les morceaux de texte arrivent un mot à la fois : on les recolle
          // tant qu'ils se suivent, sinon l'écran du robot ne montrerait
          // qu'une syllabe.
          const previous = actionsRef.current.get(id);
          const chunk = String((event as { delta?: string }).delta ?? '');
          const joined = previous?.kind === 'text' && Date.now() - (previous.at ?? 0) < 8000
            ? `${previous.detail ?? ''}${chunk}`.slice(-220)
            : chunk.slice(-220);
          remember(id, { kind: 'text', detail: joined });
          break;
        }
        case 'thinking':
          remember(id, { kind: 'think', detail: String((event as { text?: string }).text ?? '').slice(-220) });
          break;
        case 'user_echo':
          remember(id, { kind: 'user', detail: String((event as { content?: string }).content ?? '').slice(0, 220) });
          break;
        case 'stop':
          remember(id, { kind: 'stop' });
          break;
        case 'compaction':
          remember(id, { kind: 'compact' });
          break;
        case 'bg_task': {
          const task = event as { kind?: string; description?: string };
          if (task.kind === 'started') remember(id, { kind: 'bg', detail: task.description ?? '' });
          break;
        }
        case 'error':
          remember(id, { kind: 'error', detail: String((event as { msg?: string }).msg ?? '') });
          break;
        case 'turn_error':
          remember(id, { kind: 'error', detail: String((event as { kind?: string }).kind ?? '') });
          break;
        case 'external_message':
          applyExternal(id, event as never);
          break;
        case 'peer_message_status':
          applyPeerStatus(id, event as never);
          break;
        default:
          break;
      }
    }

    /** Un message venu d'un autre robot : il traverse la salle. */
    function applyExternal(id: string, event: {
      text: string; from?: string; sourceSessionId?: string; expectsReply?: boolean;
    }) {
      remember(id, { kind: 'peer', peer: 'in', who: event.from, detail: event.text });
      setSessions((previous) => {
        const me = previous.find((s) => s.id === id);
        worldRef.current?.bubble({
          from: event.from ? `@${event.from}` : 'a robot',
          fromSession: event.sourceSessionId ?? null,
          fromHandle: event.from ?? null,
          toSession: id,
          toHandle: me?.handle ?? null,
          text: event.text,
          status: 'received',
        });
        return previous;
      });
    }

    function applyPeerStatus(id: string, event: {
      status: string; target?: string; targetSessionId?: string; text?: string; error?: string;
    }) {
      if (event.status === 'replied') {
        remember(id, { kind: 'peer', peer: 'in', who: event.target, detail: event.text ?? '' });
        setSessions((previous) => {
          const me = previous.find((s) => s.id === id);
          worldRef.current?.bubble({
            from: event.target ? `@${event.target}` : 'a robot',
            fromSession: event.targetSessionId ?? null,
            fromHandle: event.target ?? null,
            toSession: id,
            toHandle: me?.handle ?? null,
            text: event.text ?? 'reply',
            status: 'replied',
          });
          return previous;
        });
      } else if (event.status === 'failed' || event.status === 'timed_out') {
        remember(id, { kind: 'peer', peer: 'out', who: event.target, detail: event.error ?? event.status });
      }
    }

    const offReconnect = subscribeReconnect(() => {
      setLive(true);
      void refresh();
    });

    return () => {
      off();
      offReconnect();
    };
  }, [refresh, touch]);

  /* ------------------------------------------------- ce que la salle raconte */

  const counts = useMemo(() => {
    const tally = emptyCounts();
    for (const session of sessions) tally[stateOf(session).id] += 1;
    return tally;
  }, [sessions]);

  const open = useMemo(
    () => (openId ? sessions.find((s) => s.id === openId) ?? null : null),
    [openId, sessions]
  );

  const siblings = useMemo(() => {
    if (!open) return [];
    return sessions
      .filter((s) => s.vpsId === open.vpsId && s.id !== open.id && s.handle)
      .map((s) => ({
        id: s.id,
        name: s.name ?? null,
        handle: s.handle as string,
        status: String(s.liveStatus ?? s.status),
      }));
  }, [sessions, open]);

  const openVps = useMemo(
    () => (open ? vps.find((v) => v.id === open.vpsId) ?? null : null),
    [open, vps]
  );

  // Le placard ouvert : la machine visée, et ses robots endormis. La liste est
  // celle de Charon, dans son ordre — le desk ne trie rien, sinon la même
  // session changerait de rang d'une seconde à l'autre.
  const storeVps = useMemo(
    () => (storeId ? vps.find((v) => v.id === storeId) ?? null : null),
    [storeId, vps]
  );

  const storeAsleep = useMemo(
    () => (storeId ? sessions.filter((s) => s.vpsId === storeId && stateOf(s).id === 'asleep') : []),
    [storeId, sessions]
  );

  // La ligne vivante d'un identifiant : c'est ce que le menu du clic droit, le
  // dialogue de renommage et celui de suppression regardent. Une session
  // supprimée ailleurs disparaît donc d'elle-même de ces trois-là.
  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s] as const)), [sessions]);
  const menuSession = menu ? byId.get(menu.id) ?? null : null;
  const renamingSession = renaming ? byId.get(renaming) ?? null : null;
  const deletingSession = deleting ? byId.get(deleting) ?? null : null;

  /* ------------------------------------------------------------------ effets */

  // Ouvrir une session, c'est la regarder : on le dit au serveur, qui efface
  // la marque « fini, pas ouvert » — la même route que Charon appelle. La
  // fermer la remet dans la salle, et la pastille verte revient si le tour
  // s'est terminé entre-temps.
  useEffect(() => {
    void setFocus(openId);
    if (!openId) return;
    setSessions((previous) =>
      previous.map((s) => (s.id === openId && s.unreadStop ? { ...s, unreadStop: 0 } : s))
    );
  }, [openId]);

  // Le clavier appartient au modal tant qu'il est ouvert — session ou liste.
  useEffect(() => {
    worldRef.current?.setInputEnabled(!open && !storeId);
  }, [open, storeId]);

  const select = useCallback((id: string | null) => {
    worldRef.current?.select(id);
    if (id) worldRef.current?.focusOn(id);
  }, []);

  // Ouvrir un dormant depuis le placard, c'est le même geste qu'ouvrir un
  // robot depuis la salle : sa session, par-dessus, et la liste qui attend
  // derrière. La caméra, elle, ne bouge pas plus que pour un robot — la salle
  // doit être là où on l'a laissée quand tout se referme.
  const openSession = useCallback((id: string) => {
    worldRef.current?.select(id);
    setOpenId(id);
  }, []);

  // Recentrer, c'est revenir à la vue d'entrée : le milieu de l'allée, assez
  // haut pour embrasser les deux rangées. Le point de vue appartient à la
  // salle — elle seule connaît ses bornes.
  const onRecenter = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    world.select(null);
    world.recenter();
  }, []);

  /* ------------------------------------------------- le menu du clic droit */

  // Endormir ou réveiller : la MÊME route que la barre latérale de Charon. La
  // salle ne dort personne elle-même — elle demande, Charon exécute, et elle se
  // recolle au résultat. Ce qu'une session peut recevoir n'est pas non plus
  // décidé ici : `canSleepSession` / `canResumeSession` sont les règles de
  // Charon, et la salle ne fait que leur poser la question.
  const lifecycle = useCallback((action: 'sleep' | 'resume', id: string) => {
    const call = action === 'sleep' ? api.sleepClaudeSession : api.resumeClaudeSession;
    void call(id).then(() => refresh()).catch((e: unknown) => {
      setError(`${action}: ${e instanceof Error ? e.message : String(e)}`);
      void refresh();
    });
  }, [refresh]);

  // Supprimer. L'erreur n'est pas attrapée ici : elle remonte à `<ConfirmModal>`,
  // qui la montre sous la question à laquelle elle répond — au lieu d'une bande
  // en haut de la salle, loin du bouton qu'on vient de presser.
  const deleteOne = useCallback(async (id: string) => {
    try {
      await api.deleteClaudeSession(id);
    } catch (error) {
      void refresh();
      throw error;
    }
    // Le robot sort de la salle à l'instant : l'événement SSE peut se perdre, et
    // on ne veut pas d'un fantôme jusqu'au sondage de la minute.
    setSessions((previous) => previous.filter((session) => session.id !== id));
    setOpenId((current) => (current === id ? null : current));
    void refresh();
  }, [refresh]);

  // Renommer : le nom de Charon (`name`), pas l'adresse. Voir l'avertissement du
  // dialogue — une plaque écrit l'adresse tant que le robot en a une.
  const applyRename = useCallback(async (id: string, name: string) => {
    await api.renameClaudeSession(id, name || null);
    setRenaming(null);
    void refresh();
  }, [refresh]);

  // Refermer le menu. Cette fonction doit être STABLE, et c'est une contrainte
  // de `SessionContextMenu`, pas une coquetterie : son garde-fou de 350 ms — celui
  // qui empêche l'appui long d'un écran tactile de refermer le menu qu'il vient
  // d'ouvrir — vit dans un effet dont `onClose` est la dépendance, si bien qu'un
  // `onClose` recréé à chaque rendu REJOUE l'effet et repousse le garde-fou. Or
  // la salle se rend au moins une fois par seconde (le pouls, les images par
  // seconde, chaque événement du flux), et bien plus souvent quand la flotte
  // parle : le menu ne se refermait alors plus au clic, ou seulement par chance,
  // dans l'accalmie. `useCallback` le fixe une fois pour toutes.
  const closeMenu = useCallback(() => setMenu(null), []);

  /* ------------------------------------------------------------------ rendu */

  return (
    <div className="desk">
      {/* La toile ET les étiquettes : la salle accroche son calque ici même,
          à côté du canvas. Ce div ne contient donc rien au premier rendu, et
          c'est normal — React n'a pas à connaître ces éléments-là. */}
      <div className="desk-stage" ref={stageRef} />
      <Hud
        counts={counts}
        total={sessions.length}
        awake={sessions.length - counts.asleep}
        asleep={counts.asleep}
        machines={vps.length}
        zones={folders.length}
        onFloor={onFloor}
        fps={fps}
        live={live}
        fresh={fresh}
        onRecenter={onRecenter}
        onHelp={() => setHelp((value) => !value)}
      />

      {error && <div className="dsk-banner">Charon ne répond pas — {error}</div>}

      {/* Le menu d'un robot : celui de Charon, monté tel quel. Le desk ne
          redessine pas ses entrées et n'en invente aucune — ce qu'une session
          peut recevoir, c'est Charon qui le sait. Trois seulement, et elles
          sont posées : renommer, endormir (ou réveiller), supprimer.

          Ce que la salle ne propose PAS, et pourquoi : la couleur d'une ligne
          (dans la salle, la teinte d'un robot est son ÉTAT — une couleur de
          ligne viendrait la contredire), et l'adresse / le dossier de travail
          (ce sont les vocabulaires de Charon, on les édite là-bas). */}
      {menuSession && menu && (
        <SessionContextMenu
          title={roomName(menuSession)}
          subtitle={menuSession.cwd || undefined}
          x={menu.x}
          y={menu.y}
          showColor={false}
          onRename={() => setRenaming(menuSession.id)}
          // Un robot endormi n'est plus dans la salle — il est dans l'armoire —,
          // donc « Resume » ne se présente ici que pour un robot en erreur, le
          // seul cas où la salle montre un robot que Charon sait réveiller.
          onSleep={canSleepSession(menuSession) ? () => lifecycle('sleep', menuSession.id) : undefined}
          onResume={canResumeSession(menuSession) ? () => lifecycle('resume', menuSession.id) : undefined}
          onDelete={() => setDeleting(menuSession.id)}
          onClose={closeMenu}
        />
      )}

      {renamingSession && (
        <PromptModal
          title="Rename session"
          // Dit où ce nom se lit VRAIMENT. La plaque d'un robot écrit son
          // adresse tant qu'il en a une : renommer un robot qui a un handle ne
          // change donc rien dans la salle, et il faut le dire avant, pas après.
          hint={renamingSession.handle
            ? <>Charon’s list, and this session’s header, show this name. Its plate in the room keeps writing <b>@{renamingSession.handle}</b> — that is its address, and an address is not renamed.</>
            : <>This name is what Charon’s list, the header, and the robot’s plate in the room all show.</>}
          initial={renamingSession.name ?? ''}
          placeholder={renamingSession.cwd.split('/').filter(Boolean).pop() ?? undefined}
          confirmLabel="rename"
          busyLabel="renaming…"
          icon="✎"
          onSubmit={(value) => applyRename(renamingSession.id, value)}
          onClose={() => setRenaming(null)}
        />
      )}

      {deletingSession && (
        <ConfirmModal
          title="Delete session"
          confirmLabel="delete permanently"
          busyLabel="deleting…"
          onConfirm={() => deleteOne(deletingSession.id).then(() => setDeleting(null))}
          onClose={() => setDeleting(null)}
        >
          <div className="confirm-target">
            <span className="ct-name">{roomName(deletingSession)}</span>
            <span className="ct-sub">{deletingSession.cwd}</span>
          </div>
          <p className="confirm-text">
            The session and its whole history (messages, permissions, logs) will be
            permanently deleted. This cannot be undone — to keep it, put the robot to
            sleep instead.
          </p>
        </ConfirmModal>
      )}

      {/* Le placard est monté AVANT le modal de session : à z-index égal, c'est
          le dernier du DOM qui passe devant. La liste reste donc derrière la
          session qu'on vient d'ouvrir dedans, et la refermer la retrouve. */}
      {storeVps && (
        <StoreModal
          vps={storeVps}
          asleep={storeAsleep}
          covered={Boolean(open)}
          onOpenSession={openSession}
          onClose={() => setStoreId(null)}
        />
      )}

      {open && (
        <SessionModal
          session={open}
          vps={openVps}
          siblings={siblings}
          action={actionsRef.current.get(open.id) ?? null}
          onClose={() => { select(null); setOpenId(null); }}
          onOpenSession={(id) => { select(id); setOpenId(id); }}
          onSessionsChanged={() => void refresh()}
        />
      )}

      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="dsk-modal" role="dialog" aria-modal="true">
      <div className="dsk-veil" onClick={onClose} />
      <div
        className="dsk-card"
        style={{
          position: 'relative', margin: 'auto', width: 'min(720px, 92vw)',
          maxHeight: '80vh', overflow: 'auto', padding: '24px 28px', lineHeight: 1.55, fontSize: 13.5
        }}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>The desk</h2>
        <p style={{ margin: '0 0 12px', color: 'var(--dsk-dim)' }}>
          Charon’s machine room, in three dimensions. Every robot is an open session;
          every bay is a VPS; every zone painted on the floor is a folder from its
          sidebar. Nothing here is simulated: what you see is Charon’s real state,
          pushed by its own event stream.
        </p>
        <ul style={{ margin: '0 0 14px', paddingLeft: 18, color: 'var(--dsk-dim)' }}>
          <li><b>One click</b> on a robot opens its session — the real one, with its
            transcript, its composer and its file browser.</li>
          <li><b>The three pulses</b>: blue, the turn is running; orange, a permission
            or a question is waiting; green, a turn ended and nobody has opened it.</li>
          <li><b>The shells</b> are painted in the engine’s colour: every agent family
            has its own, and a session routed to an endpoint also carries a dot in
            that endpoint’s tint.</li>
          <li><b>The folders</b> are the third level, and they branch. Inside a
            machine, every working directory is a painted floor, named in its own
            aisle band: the robots that share it stand in single file on it, one
            behind the other, receding from the aisle. A directory that contains
            others opens their floors inside its own, side by side and at the
            same depth — so the room is read like the tree it is, and it is
            Charon’s tree: same grouping, same order as its sidebar. A folder
            with one sub-folder and no robot of its own gets no floor at all —
            its name simply grows (<code>/opt/iron_golem</code>).</li>
        </ul>
        <p style={{ margin: '0 0 10px', color: 'var(--dsk-faint)', fontSize: 12.5 }}>
          The legend on the left folds away — click its title. It is folded by
          default: it would otherwise sit on the busiest machine of the room.
          This page lives in <code>app/desk/</code> and only ever reads Charon:
          delete the folder and Charon will not notice.
        </p>
        <button className="dsk-open" type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
