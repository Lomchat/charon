// La salle, vue depuis React.
//
// `world.js` et ses voisins sont du JavaScript : Three.js n'a pas à entrer dans
// le typage de Charon, et la salle n'a pas à être recompilée par `tsc`. Ce
// fichier est la seule frontière — tout ce qui est .tsx passe par ici.

import type { Vps, VpsFolder } from '@/lib/types/api';
import type { DeskAction, DeskSession } from './palette';

export type DeskModel = {
  sessions: DeskSession[];
  vps: Vps[];
  folders: VpsFolder[];
};

export type Station = {
  session: DeskSession;
  x: number;
  z: number;
  yaw: number;
  quai: Quai;
};

/** Le placard de stockage d'une machine : un maillage, une position, et les
 *  robots endormis qu'il contient. C'est lui qu'on ouvre — un clic dessus ne
 *  mène pas à une session mais à leur liste. */
export type Store = {
  quai: Quai;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  yaw: number;
  sessions: DeskSession[];
};

/** Un SOL de quai : les robots d'un dossier de travail, en file indienne, sur
 *  une dalle peinte — et sous cette dalle, celles de ses sous-dossiers.
 *
 *  Le chemin est la clé de Charon (`sidebarPathKey`) — `~` pour un dossier de
 *  travail vide, un chemin sans sa barre oblique finale. Deux robots que la
 *  barre latérale de Charon range sous le même titre sont donc sur le même sol,
 *  dans le même ordre ; et les chemins qui descendent d'un même dossier sont
 *  des sols posés DANS le sien, côte à côte, à la même profondeur. Un sol qui
 *  n'a rien à lui et un seul enfant n'existe pas : son nom s'allonge dans celui
 *  de son enfant (`/opt/iron_golem`), et les sols sont la seule liste plate que
 *  la salle publie — l'arbre est dans leurs positions. */
export type PathLevel = {
  path: string;
  /** Les robots de CE dossier : ceux de sa propre file. */
  sessions: DeskSession[];
  /** Le rang du sol dans son quai, dans l'ordre de lecture : les travées du
   *  quai d'abord, puis les sous-dossiers à la suite de leur parent. */
  lane: number;
  /** Combien de robots sur ce sol ET sous lui — ce que dit son titre. */
  count: number;
  /** Combien de robots sur ce sol seulement : la longueur de sa file, donc sa
   *  profondeur en postes. */
  own: number;
  /** La dalle peinte du sol, en coordonnées monde : elle englobe ses enfants. */
  x: number;
  z: number;
  w: number;
  d: number;
  /** Où flotte le titre du chemin : dans la bande d'accostage du sol, à la
   *  verticale du nom peint, devant ses postes. */
  title: { x: number; z: number };
  /** Où le nom du dossier est PEINT, à plat sur sa propre bande d'accostage.
   *  `base` est l'orientation du texte au repos — `faceCamera` le retourne
   *  ensuite face au visiteur. */
  label: { x: number; z: number; w: number; d: number; base: number };
};

export type Quai = {
  id: string;
  name: string;
  agentStatus: string;
  folderId: string;
  folderName: string;
  side: number;
  x: number;
  width: number;
  depth: number;
  /** Combien de sols de premier niveau (de travées) le quai porte. */
  lanes: number;
  /** La profondeur de sa plus longue file, en postes. */
  deep: number;
  origin: { x: number; z: number };
  sessions: DeskSession[];
  awake: DeskSession[];
  asleep: DeskSession[];
  desks: Station[];
  /** Les sous-niveaux du quai, dans l'ordre de Charon. */
  levels: PathLevel[];
  /** La boîte du nom de la machine peint au sol, derrière les postes. Le nom
   *  lui-même reste `name`, la chaîne — c'est elle que peignent les textures. */
  floorName: { x: number; z: number; w: number; d: number; base: number };
  /** `null` quand la machine n'a aucun robot endormi : pas de placard vide. */
  store: Store | null;
};

export type Zone = {
  id: string;
  name: string;
  side: number;
  x0: number;
  x1: number;
  machines: number;
};

export type DeskLayout = {
  quais: Quai[];
  zones: Zone[];
  idleVps: Vps[];
  span: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  center: { x: number; z: number };
};

/** Un message entre deux robots, prêt à traverser la salle. */
export type DeskEdge = {
  from: string;
  fromSession?: string | null;
  fromHandle?: string | null;
  toSession?: string | null;
  toHandle?: string | null;
  text: string;
  status?: string;
};

export type HoveredRobot = DeskSession | null;

export type WorldOptions = {
  onOpen?: (sessionId: string) => void;
  onHover?: (session: HoveredRobot) => void;
  /** Un placard de stockage ouvert : l'identifiant du VPS dont il faut montrer
   *  les robots endormis. */
  onStore?: (vpsId: string) => void;
};

export declare class World {
  constructor(container: HTMLElement, options?: WorldOptions);
  layout: DeskLayout | null;
  /** La coque de la salle : sol, quais, enseignes. Publique pour que les scripts
   *  de vérification puissent l'interroger, et pour `faceCamera`. */
  hall: { faceCamera(camera: unknown): void } | null;
  model: DeskModel;
  selectedId: string | null;
  hoveredId: string | null;
  /** Le quai dont le placard est sous le curseur, s'il y en a un. */
  hoveredStore: string | null;
  onStats: ((fps: number) => void) | null;
  onLayout: ((layout: DeskLayout) => void) | null;

  update(model: DeskModel, actions?: Map<string, DeskAction>): void;
  start(): void;
  stop(): void;
  resize(): void;

  hover(event: { clientX: number; clientY: number }): void;
  select(sessionId: string | null): void;
  focusOn(sessionId: string, radius?: number): void;
  recenter(): void;
  bubble(edge: DeskEdge): void;
  setInputEnabled(enabled: boolean): void;
  dispose(): void;
}
