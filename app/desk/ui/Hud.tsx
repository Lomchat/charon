'use client';

// L'habillage du desk.
//
// Il ne raconte rien que la salle ne montre déjà : les compteurs comptent les
// mêmes états que les voyants, la légende énumère les mêmes couleurs. Un
// tableau de bord qui inventerait ses propres chiffres serait un second
// système à tenir à jour — et le premier à mentir.

import { useEffect, useState } from 'react';
import { FAMILIES, PULSES, STATES, type DeskState } from '../hall/palette';

export type Counts = Record<DeskState['id'], number>;

type Props = {
  counts: Counts;
  total: number;
  awake: number;
  asleep: number;
  machines: number;
  zones: number;
  /** Combien de machines la salle a réellement posées : les autres n'ont aucun
   *  agent éveillé et sont restées au garage. `null` tant que rien n'est posé. */
  onFloor: number | null;
  fps: number;
  live: boolean;
  fresh: number | null;
  onRecenter: () => void;
  onHelp: () => void;
};

const STEADY: DeskState[] = [STATES.ready, STATES.broken, STATES.reconnecting, STATES.asleep];

/** La légende se replie, et elle est repliée au départ.
 *
 *  Elle fait 33 cm de large sur 43 de haut : posée là, elle mange le tiers
 *  gauche de l'écran, c'est-à-dire le quai le plus peuplé, les titres de ses
 *  files et les noms de ses robots. Une légende qu'on lit une fois ne peut pas
 *  coûter ça — elle se déplie au clic, et elle se souvient de son état. */
const LEGEND_KEY = 'desk.legend';

export default function Hud({
  counts, total, awake, asleep, machines, zones, onFloor, fps, live, fresh, onRecenter, onHelp
}: Props) {
  const [legend, setLegend] = useState(false);

  // L'état est relu après le montage, pas pendant : `localStorage` n'existe pas
  // au rendu du serveur, et le lire ici ferait diverger les deux rendus.
  useEffect(() => {
    setLegend(localStorage.getItem(LEGEND_KEY) === '1');
  }, []);
  const replier = (open: boolean) => {
    setLegend(open);
    try {
      localStorage.setItem(LEGEND_KEY, open ? '1' : '0');
    } catch {
      // Un navigateur qui refuse le stockage n'a pas à empêcher de lire la salle.
    }
  };

  return (
    <div className="desk-hud">
      <div className="dsk-top">
        <div className="dsk-brand">
          <h1>
            The <span>desk</span>
            <em>Charon's machine room</em>
          </h1>
          <p>
            <i className={`dsk-live${live ? '' : ' off'}`} />
            {live
              ? `live feed${fresh != null ? ` · ${fresh}s` : ''}`
              : 'feed interrupted — reconnecting'}
            {' · '}
            {machines} machines, {zones} folders
            {onFloor != null && onFloor < machines ? <> · <b>{onFloor} on the floor</b></> : null}
          </p>
        </div>
        <div className="dsk-actions">
          <button type="button" onClick={onRecenter}>Recenter</button>
          <button type="button" onClick={onHelp}>?</button>
        </div>
      </div>

      <div className="dsk-stats dsk-card">
        <div className="dsk-stat">
          <b>{total}</b>
          <span>robots</span>
        </div>
        <div className="dsk-stat">
          <b>{counts.question}</b>
          <span>questions</span>
        </div>
        <div className="dsk-stat">
          <b>{counts.unread}</b>
          <span>unread</span>
        </div>
        <div className="dsk-stat">
          <b>{counts.working + counts.background}</b>
          <span>working</span>
        </div>
        <div className="dsk-stat">
          <b>{asleep}</b>
          <span>asleep</span>
        </div>
        <div className="dsk-stat">
          <b>{awake}</b>
          <span>awake</span>
        </div>
      </div>

      <div className={`dsk-legend dsk-card${legend ? '' : ' closed'}`}>
        <button
          type="button"
          className="dsk-legend-head"
          aria-expanded={legend}
          onClick={() => replier(!legend)}
        >
          <h2>What a robot tells you</h2>
          <i className="dsk-caret" aria-hidden="true">{legend ? '▾' : '▸'}</i>
        </button>

        <div className="dsk-legend-body">
          <ul>
            {PULSES.map((state) => (
              <li key={state.id} style={{ color: state.pulse ?? undefined }}>
                <i style={{ animationDuration: `${(1 / Math.max(0.15, state.speed)).toFixed(2)}s` }} />
                <b>{state.label}</b>
                <span>{state.hint}</span>
              </li>
            ))}
            {STEADY.map((state) => (
              <li key={state.id} className="steady" style={{ color: state.tint ?? '#6b7787' }}>
                <i />
                <b>{state.label}</b>
                <span>{state.hint}</span>
              </li>
            ))}
          </ul>

          <h2>What an engine tells you</h2>
          <div className="dsk-families">
            {FAMILIES.map((family) => (
              <span className="dsk-chip" key={family.id}>
                {family.logo && <img src={family.logo} alt="" />}
                <i style={{ background: family.css }} />
                {family.label}
              </span>
            ))}
          </div>

          <p className="dsk-note">
            Orange is a question — the robot has its hand raised. Green is a turn
            that ended and nobody opened. Blue is a turn in progress. The other
            states never pulse: in a dark room, what moves is what wants you. The
            whole robot takes its state's colour, not just its lamp. Every monitor
            wears its engine's mark, so the room reads from far away. A robot's
            name is a card on its desk, behind the monitor: the card wears the
            state's colour and beats with the robot. Walk up to a station to read
            the name, or point at a robot from anywhere — its name comes to you.
            From across the room, what you read is the colour.
          </p>
        </div>
      </div>

      <p className="dsk-hint">
        <b>Click</b> a robot: its session opens right here, with its files.
        {' '}<b>Hover</b> one: its name.
        {' '}<b>Esc</b> closes it — unless something is written in the composer,
        which stays.
        {' '}A machine's sleeping robots are in the <b>cabinet</b> behind its
        desks — one click on it lists them.
        {' '}<b>Drag</b>: orbit. <b>Wheel</b>: move closer.
        {' '}<b>WASD</b>: walk, <b>Space</b> and <b>Ctrl</b> to rise and sink,
        {' '}<b>Shift</b> to speed up.
      </p>
      <p className="dsk-perf">{fps.toFixed(0)} fps</p>
    </div>
  );
}
