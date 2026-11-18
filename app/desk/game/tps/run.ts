// What the 3D phase needs from the run it belongs to (game/arcade.ts): the
// score, the combo, the count of the waves, the sound — they are the run's,
// whatever the pilot is doing, on foot or in a vehicle.
import type { ArcadeAudio } from '../audio';

export type TpsRun = {
  audio: ArcadeAudio;
  /** A kill: the points, with the combo's multiplier; returns what was gained. */
  score: (base: number) => number;
  /** The pilot's vehicle was hit: the combo is lost. */
  hit: () => void;
  say: (text: string) => void;
  /** The wave being fought (or just fought). */
  wave: () => number;
  /** The next wave begins: its number, and whether it brings a boss. */
  nextWave: () => { n: number; boss: boolean };
  cleared: () => void;
  /** The vehicle is destroyed: the run is over. */
  over: () => void;
};
