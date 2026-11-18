'use client';
import { useEffect, useRef } from 'react';
import { art, drawRobot, robotKind, type RobotPose } from '../game/art';
import { MOOD_COLOR, type Mood } from '../game/model';

/** The robot, enlarged: the same sprite as on the board, in the same mood. */
export default function Portrait({ kind, mood, chest, scale = 4 }: {
  kind: string; mood: Mood; chest?: string | null; scale?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return undefined;
    const robot = art().robots[robotKind(kind)];
    const started = performance.now();
    const paint = () => {
      const t = performance.now() - started;
      const colour = MOOD_COLOR[mood];
      const pose: RobotPose = {
        bob: Math.floor(t / 600) % 2, legs: mood === 'sleep' ? 'sit' : 'stand',
        armL: mood === 'done' ? 'up' : 'down', armR: mood === 'done' || mood === 'blocked' || mood === 'question' ? 'up' : 'down',
        armLdy: mood === 'work' ? Math.floor(t / 150) % 2 : 0,
        armRdy: mood === 'work' ? (Math.floor(t / 150) + 1) % 2 : mood === 'blocked' ? -(Math.floor(t / 300) % 2) : 0,
        eye: mood === 'sleep' ? null : mood === 'idle' ? (t % 4000 < 140 ? null : '#cfe0fb') : colour,
        lamp: mood === 'idle' || mood === 'sleep' ? '#55607a' : Math.floor(t / 300) % 2 ? colour : '#1c2433',
        chest: chest && /^#[0-9a-f]{6}$/i.test(chest) ? chest : '#ffd98a',
        scan: 0.5 + 0.5 * Math.sin(t * 0.006), alpha: mood === 'sleep' ? 0.8 : 1,
      };
      g.clearRect(0, 0, canvas.width, canvas.height);
      drawRobot(g, robot, 10, 23, pose);
    };
    paint();
    const timer = setInterval(paint, 140);
    return () => clearInterval(timer);
  }, [kind, mood, chest]);
  return (
    <canvas
      ref={ref}
      className="dk-portrait"
      width={20}
      height={24}
      style={{ width: 20 * scale, height: 24 * scale }}
      aria-hidden="true"
    />
  );
}
