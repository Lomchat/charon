'use client';
import { useSyncExternalStore } from 'react';
import { isPathDrag } from './pathDrag';
import { FS_UPLOAD_MAX_ITEMS } from '@/lib/fsUpload';

/**
 * A file dragged in from the OS has TWO destinations, and they must never be
 * confused (§14.82 lists the app's in-app drags):
 *
 *   • the CHAT — anywhere outside the right panel: uploaded to
 *     `.charon-uploads/` and its path spliced into the message (§14.73);
 *   • an UPLOAD ZONE — the explorer tree: uploaded into the folder under the
 *     pointer, under its ORIGINAL name, and nothing is said to the agent.
 *
 * The right panel as a whole belongs to the server side: outside its zone a
 * drop does nothing, so letting go over the git tab never attaches a file by
 * surprise. This module is the shared truth both sides read — is an OS file
 * drag over the window, and is the pointer in a zone — so the chat overlay can
 * step aside while the tree lights up, and vice versa.
 */
export const UPLOAD_ZONE_ATTR = 'data-fs-upload-zone';

/** An OS file drag — never one of the app's own drags (a path, a reorder). */
export function isOsFileDrag(dt: DataTransfer | null): boolean {
  if (!dt || isPathDrag(dt)) return false;
  return Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
}

export function uploadZoneOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest(`[${UPLOAD_ZONE_ATTR}]`) : null;
}

/** Left edge of the ON-SCREEN right panel, where the chat's drop overlay must
 *  stop — or null when there is none (closed drawer, no panel at all). */
export function toolPanelLeft(): number | null {
  const panel = document.querySelector('.tool-panel');
  if (!panel) return null;
  const r = panel.getBoundingClientRect();
  if (r.width < 1 || r.left >= window.innerWidth - 1) return null;
  return r.left;
}

type OsDrag = { active: boolean; zone: Element | null };
const IDLE: OsDrag = { active: false, zone: null };
let current: OsDrag = IDLE;
const subs = new Set<() => void>();
let depth = 0;
let watchdog: ReturnType<typeof setTimeout> | null = null;

function publish(next: OsDrag) {
  if (next.active === current.active && next.zone === current.zone) return;
  current = next;
  for (const cb of subs) cb();
}

function reset() {
  depth = 0;
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  publish(IDLE);
}

// dragover repeats every few hundred ms while the pointer is over the page,
// even motionless. Silence means the drag ended somewhere we were not told
// about (a dragleave eaten by a removed element, Escape outside the window).
function rearm() {
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(reset, 1500);
}

const onEnter = (e: DragEvent) => {
  if (!isOsFileDrag(e.dataTransfer)) return;
  depth++;
  rearm();
  publish({ active: true, zone: uploadZoneOf(e.target) });
};
const onOver = (e: DragEvent) => {
  if (!isOsFileDrag(e.dataTransfer)) return;
  rearm();
  publish({ active: true, zone: uploadZoneOf(e.target) });
};
const onLeave = (e: DragEvent) => {
  if (!isOsFileDrag(e.dataTransfer)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) reset();
};
// On `document`, which bubbles BEFORE `window`: outside a zone this refuses
// the drop by default, so a view with no chat (file editor, shell) does not
// let the browser navigate away to the dropped file. The chat's own window
// listener runs after and re-opens it where attaching is the answer.
const onDocOver = (e: DragEvent) => {
  if (!isOsFileDrag(e.dataTransfer) || uploadZoneOf(e.target)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
};
const onDocDrop = (e: DragEvent) => {
  if (!isOsFileDrag(e.dataTransfer) || uploadZoneOf(e.target)) return;
  e.preventDefault();
};

function subscribe(cb: () => void): () => void {
  if (subs.size === 0) {
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    // Capture: a drop target further down may stop the bubble, and the
    // store must still learn that the drag is over.
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset, true);
    document.addEventListener('dragover', onDocOver);
    document.addEventListener('drop', onDocDrop);
  }
  subs.add(cb);
  return () => {
    subs.delete(cb);
    if (subs.size) return;
    window.removeEventListener('dragenter', onEnter);
    window.removeEventListener('dragover', onOver);
    window.removeEventListener('dragleave', onLeave);
    window.removeEventListener('drop', reset, true);
    window.removeEventListener('dragend', reset, true);
    document.removeEventListener('dragover', onDocOver);
    document.removeEventListener('drop', onDocDrop);
    reset();
  };
}

/** Is an OS file drag over the window, and which upload zone (if any) is the
 *  pointer in. Re-renders on those two changes only, never per row. */
export function useOsFileDrag(): OsDrag {
  return useSyncExternalStore(subscribe, () => current, () => IDLE);
}

// ── What was dropped ──────────────────────────────────────────────────────
// `webkitGetAsEntry` is the only way to tell a dropped FOLDER from a file, and
// it only works DURING the drop event — the DataTransfer is emptied the moment
// the handler returns. So capture synchronously, walk asynchronously.

export type DroppedRoot = { entry: FileSystemEntry | null; file: File | null };
export type UploadPlan = {
  /** Folders to create, relative to the target, parents first. */
  dirs: string[];
  /** Files, relative to the target. */
  files: { rel: string; file: File }[];
  /** The dropped items themselves, relative to the target. */
  top: string[];
};

export function captureDrop(dt: DataTransfer): DroppedRoot[] {
  const out: DroppedRoot[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    out.push({ entry: item.webkitGetAsEntry?.() ?? null, file: item.getAsFile() });
  }
  if (!out.length) for (const file of Array.from(dt.files ?? [])) out.push({ entry: null, file });
  return out;
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // readEntries hands out batches (~100 in Chrome) until an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
    if (all.length > FS_UPLOAD_MAX_ITEMS) return all;
  }
}

/** Walk the drop into folders + files. Throws past FS_UPLOAD_MAX_ITEMS. */
export async function planDrop(roots: DroppedRoot[]): Promise<UploadPlan> {
  const plan: UploadPlan = { dirs: [], files: [], top: [] };
  const tooMany = () => new Error(
    `more than ${FS_UPLOAD_MAX_ITEMS} files and folders — upload an archive instead`);
  const walk = async (entry: FileSystemEntry, rel: string) => {
    if (plan.dirs.length + plan.files.length >= FS_UPLOAD_MAX_ITEMS) throw tooMany();
    if (entry.isDirectory) {
      plan.dirs.push(rel);
      for (const child of await readAll(entry as FileSystemDirectoryEntry)) {
        await walk(child, `${rel}/${child.name}`);
      }
    } else {
      plan.files.push({ rel, file: await fileOf(entry as FileSystemFileEntry) });
    }
  };
  for (const root of roots) {
    const name = root.entry?.name ?? root.file?.name;
    if (!name) continue;
    plan.top.push(name);
    if (root.entry) await walk(root.entry, name);
    else if (root.file) plan.files.push({ rel: name, file: root.file });
  }
  return plan;
}
