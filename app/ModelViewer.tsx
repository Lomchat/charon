'use client';
import { useEffect, useRef, useState } from 'react';
import type {
  Box3, BufferGeometry, Color, GridHelper, InstancedMesh, Material, Mesh, MeshStandardMaterial, Object3D,
  Points, SkinnedMesh, Texture, Vector3,
} from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { OrbitControls as OrbitControlsClass } from 'three/examples/jsm/controls/OrbitControls.js';
import type { RoomEnvironment as RoomEnvironmentClass } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { api } from '@/lib/api';
import { rootedPath, type ByteViewerProps } from './fileViews';
import {
  MODEL_BASE, describeModelError, fitDistance, formatBytes, formatDims, formatModelStats, gltfExtensions,
  gltfUnsupported, gridSpec, isInlineImage, mixRgb, modelAbsPath, modelFormat, needsMeshopt, parseCssColor,
  plyFaceCount, pointSize, readFileBytes, resolveModelUri, type ModelFormat, type Rgb,
} from './modelViewerHelpers';

// The 3D model pane (§14.112): glTF/GLB, STL, OBJ and PLY, orbit/pan/zoom.
// Lazy twice over: this module is a lazy chunk (app/dynamic.tsx), and three.js with
// its loaders (~700KB) is imported only once a model is actually opened.
// Frames are drawn ON DEMAND — a moved camera, a resize, a new model, or the
// auto-rotation — never a standing 60 fps loop, and nothing at all while the
// pane is hidden (§14.111).

type Three = typeof import('three');
type Engine = {
  THREE: Three;
  OrbitControls: typeof OrbitControlsClass;
  RoomEnvironment: typeof RoomEnvironmentClass;
};

let enginePromise: Promise<Engine> | null = null;
function loadEngine(): Promise<Engine> {
  enginePromise ??= Promise.all([
    import('three'),
    import('three/examples/jsm/controls/OrbitControls.js'),
    import('three/examples/jsm/environments/RoomEnvironment.js'),
  ]).then(([THREE, c, e]) => ({ THREE, OrbitControls: c.OrbitControls, RoomEnvironment: e.RoomEnvironment }))
    .catch((err: unknown) => { enginePromise = null; throw err; });
  return enginePromise;
}

// ── Theme tokens → WebGL (§14.99) ───────────────────────────────────────────
// A canvas cannot read `var(--x)`: the computed token is parsed into numbers.
// Only when no token parses at all does a fallback apply — a transparent
// clear (the stage's CSS background shows through) and a mid grey model.

type Palette = { bg: Rgb | null; model: Rgb; gridMajor: Rgb | null; gridMinor: Rgb | null };

let colorProbe: CanvasRenderingContext2D | null | undefined;
/** Any CSS colour syntax → the canvas's canonical `#rrggbb`/`rgba()`. */
function canonicalColor(value: string): string {
  colorProbe ??= document.createElement('canvas').getContext('2d');
  if (!colorProbe || !value) return '';
  colorProbe.fillStyle = '#000';
  colorProbe.fillStyle = value;
  const a = String(colorProbe.fillStyle);
  colorProbe.fillStyle = '#fff';
  colorProbe.fillStyle = value;
  return a === String(colorProbe.fillStyle) ? a : '';
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const token = (name: string): Rgb | null => {
    const raw = cs.getPropertyValue(name).trim();
    return parseCssColor(raw) ?? parseCssColor(canonicalColor(raw));
  };
  const bg = token('--bg-inset') ?? token('--bg');
  const text = token('--text');
  return {
    bg,
    // Halfway between ink and ground: a mid tone that keeps its shading on a
    // dark theme and a light one alike.
    model: text && bg ? mixRgb(text, bg, 0.62) : [0.6, 0.6, 0.6],
    gridMajor: token('--border-strong') ?? token('--text-muted'),
    gridMinor: token('--border'),
  };
}

// ── Scene helpers ───────────────────────────────────────────────────────────

function forEachMaterial(o: Object3D, fn: (m: Material) => void): void {
  const m = (o as Mesh).material as Material | Material[] | undefined;
  if (Array.isArray(m)) m.forEach(fn); else if (m) fn(m);
}

function disposeMaterial(m: Material): void {
  for (const v of Object.values(m)) {
    const tex = v as Texture | null;
    if (!tex?.isTexture) continue;
    // A decoded ImageBitmap holds its pixels until closed, GPU copy or not.
    const data = tex.source?.data as { close?: () => void } | undefined;
    if (data && typeof data.close === 'function') data.close();
    tex.dispose();
  }
  m.dispose();
}

function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    (o as Mesh).geometry?.dispose();
    forEachMaterial(o, disposeMaterial);
    if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).skeleton?.dispose();
  });
}

/** Geometry-only formats get this; `userData.neutral` = recoloured per theme. */
function neutralMaterial(THREE: Three, vertexColors: boolean): MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    roughness: 0.6, metalness: 0.05, vertexColors,
    // STL/OBJ exports often wind faces inconsistently or leave a mesh open:
    // a missing back face would read as a hole.
    side: THREE.DoubleSide,
  });
  m.userData.neutral = true;
  return m;
}

type Shown = { triangles: number; points: number; meshes: number; size: [number, number, number] };
type Toggles = { wire: boolean; grid: boolean; spin: boolean };

type Stage = {
  readonly engine: Engine;
  /** Swap the model in; `keepView` holds the camera where the reader left it. */
  show(model: Object3D, keepView: boolean): Shown;
  /** Free a model that will never be shown (a load that lost the race). */
  discard(model: Object3D): void;
  resetView(): void;
  set(t: Partial<Toggles>): void;
  setActive(on: boolean): void;
  dispose(): void;
};

function emptyModelError(): Error {
  const e = new Error('empty');
  e.name = 'EmptyModel';
  return e;
}

/** Throws when WebGL is unavailable — the caller turns that into a note. */
function createStage(engine: Engine, host: HTMLElement): Stage {
  const { THREE } = engine;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.NeutralToneMapping;
  const canvas = renderer.domElement;
  canvas.className = 'mdlv-canvas';
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  scene.add(camera);
  // Image-based light from a neutral studio room: without it a metallic glTF
  // material reflects nothing and renders black.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const bakeEnvironment = () => {
    const room = new engine.RoomEnvironment();
    const map = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    return map;
  };
  let envMap = bakeEnvironment();
  scene.environment = envMap;
  // Kept low: an even room light flattens shape, the key light gives it.
  scene.environmentIntensity = 0.35;
  // White light is physics, not palette: these never follow the theme.
  const white = new THREE.Color(1, 1, 1);
  scene.add(new THREE.HemisphereLight(white, white.clone().multiplyScalar(0.25), 0.6));
  // The key light rides with the camera, above and to the left of the
  // viewer, so whichever side the reader orbits to is the lit one — top
  // faces brightest, left ones mid, right ones in shade.
  const key = new THREE.DirectionalLight(white, 2.6);
  key.position.set(-0.5, 1, 0.8);
  key.target.position.set(0, 0, 0);
  camera.add(key, key.target);

  const controls = new engine.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  let palette = readPalette();
  let model: Object3D | null = null;
  let grid: GridHelper | null = null;
  let bounds: { box: Box3; center: Vector3; radius: number } | null = null;
  let framed = false;
  const toggles: Toggles = { wire: false, grid: false, spin: false };
  let active = true;
  let disposed = false;
  let raf = 0;
  let last = 0;

  const frame = (t: number) => {
    raf = 0;
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 1 / 60;
    last = t;
    // Damping or auto-rotation still moving ⇒ 'change' ⇒ the next frame.
    controls.update(dt);
    renderer.render(scene, camera);
    // The loop settled: the next start must not see the idle gap as a step.
    if (!raf) last = 0;
  };
  const request = () => {
    if (disposed || !active || raf) return;
    raf = requestAnimationFrame(frame);
  };
  controls.addEventListener('change', request);
  // A restored context (a phone backgrounding the tab) re-uploads meshes and
  // textures by itself, but a render target's pixels are gone: bake the room
  // light again, or every metal turns black.
  const onRestored = () => {
    const stale = envMap;
    envMap = bakeEnvironment();
    scene.environment = envMap;
    stale.dispose();
    request();
  };
  canvas.addEventListener('webglcontextrestored', onRestored);

  const rgb = (c: Rgb): Color => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

  const rebuildGrid = () => {
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      forEachMaterial(grid, (m) => m.dispose());
      grid = null;
    }
    if (!bounds) return;
    const size = bounds.box.getSize(new THREE.Vector3());
    const spec = gridSpec(Math.max(size.x, size.z));
    const minor = palette.gridMinor ?? palette.model;
    grid = new THREE.GridHelper(spec.size, spec.divisions, rgb(palette.gridMajor ?? minor), rgb(minor));
    const c = bounds.box.getCenter(new THREE.Vector3());
    // A hair under the lowest point: a flat base would z-fight its lines.
    grid.position.set(c.x, bounds.box.min.y - spec.size * 1e-4, c.z);
    grid.visible = toggles.grid;
    scene.add(grid);
  };

  const applyPalette = () => {
    if (palette.bg) renderer.setClearColor(rgb(palette.bg), 1);
    else renderer.setClearColor(white, 0);
    const base = rgb(palette.model);
    model?.traverse((o) => forEachMaterial(o, (m) => {
      if (!m.userData.neutral) return;
      const c = (m as MeshStandardMaterial).color as Color | undefined;
      // Vertex colours multiply the base colour: keep it white under them.
      c?.copy(m.vertexColors ? white : base);
    }));
    rebuildGrid();
  };

  const applyWire = () => {
    model?.traverse((o) => {
      if ((o as Mesh).isMesh) forEachMaterial(o, (m) => { (m as MeshStandardMaterial).wireframe = toggles.wire; });
    });
  };

  /** Near/far/zoom-out limits for the current model, camera untouched. */
  const frameDepth = () => {
    if (!bounds) return;
    const dist = fitDistance(bounds.radius, camera.fov, camera.aspect);
    controls.maxDistance = dist * 20;
    camera.near = bounds.radius / 200;
    camera.far = Math.max(dist * 25, camera.position.distanceTo(controls.target) * 2) + bounds.radius * 4;
    camera.updateProjectionMatrix();
  };

  const fit = () => {
    if (!bounds) return;
    const dist = fitDistance(bounds.radius, camera.fov, camera.aspect);
    // A three-quarter view from the front, a little above and to the right.
    const dir = new THREE.Vector3(0.6, 0.45, 1).normalize();
    camera.position.copy(bounds.center).addScaledVector(dir, dist);
    controls.target.copy(bounds.center);
    frameDepth();
    controls.update();
    request();
  };

  const ro = new ResizeObserver(() => {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    request();
  });
  ro.observe(host);

  // A theme switch (§14.99) arrives as a new `data-theme` on <html>.
  const mo = new MutationObserver(() => {
    palette = readPalette();
    applyPalette();
    request();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  applyPalette();

  return {
    engine,
    show(next, keepView) {
      next.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(next);
      const finite = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite);
      if (box.isEmpty() || !finite) {
        disposeTree(next);
        throw emptyModelError();
      }
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const old = model;
      model = next;
      scene.add(next);
      if (old) { scene.remove(old); disposeTree(old); }
      bounds = { box, center: sphere.center, radius: Math.max(sphere.radius, 1e-6) };
      applyWire();
      applyPalette();
      if (keepView && framed) frameDepth(); else fit();
      framed = true;
      request();

      let triangles = 0, points = 0, meshes = 0;
      next.traverse((o) => {
        const g = (o as Mesh).geometry as BufferGeometry | undefined;
        if (!g) return;
        const n = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
        const copies = (o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh).count : 1;
        if ((o as Mesh).isMesh) { meshes++; triangles += Math.floor(n / 3) * copies; }
        else if ((o as Points).isPoints) points += n * copies;
      });
      const size = box.getSize(new THREE.Vector3());
      return { triangles, points, meshes, size: [size.x, size.y, size.z] };
    },
    discard: disposeTree,
    resetView: fit,
    set(t) {
      Object.assign(toggles, t);
      if (t.wire !== undefined) applyWire();
      if (t.grid !== undefined && grid) grid.visible = toggles.grid;
      if (t.spin !== undefined) controls.autoRotate = toggles.spin;
      request();
    },
    setActive(on) {
      active = on;
      if (on) { request(); return; }
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      controls.removeEventListener('change', request);
      controls.dispose();
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (model) disposeTree(model);
      if (grid) { grid.geometry.dispose(); forEachMaterial(grid, (m) => m.dispose()); }
      envMap.dispose();
      pmrem.dispose();
      renderer.dispose();
      // Browsers cap live WebGL contexts (~16): give this one back now, not
      // whenever the canvas is collected.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────────

type Parsed = { model: Object3D; missing: string[] };

/**
 * Bytes → a scene graph. `locate` maps a uri a glTF names (relative to the
 * model) to the URL of that file's bytes, or null when it is not on the VPS.
 */
async function parseModel(
  THREE: Three, format: ModelFormat, buf: ArrayBuffer, locate: (uri: string) => string | null,
): Promise<Parsed> {
  if (format === 'glb' || format === 'gltf') {
    const ext = gltfExtensions(buf);
    const why = gltfUnsupported(ext);
    if (why) { const e = new Error(why); e.name = 'UnsupportedModel'; throw e; }
    const [{ GLTFLoader }, meshopt] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      needsMeshopt(ext) ? import('three/examples/jsm/libs/meshopt_decoder.module.js') : Promise.resolve(null),
    ]);
    const missing: string[] = [];
    const asked = new Map<string, string>();
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (!url.startsWith(MODEL_BASE)) return url; // data:, blob:, a remote URL
      const uri = url.slice(MODEL_BASE.length);
      const target = locate(uri) ?? url;
      asked.set(target, uri);
      return target;
    });
    // A missing texture is not fatal (three.js leaves the slot empty): it is
    // reported in the toolbar. A missing buffer fails the whole parse.
    manager.onError = (url) => { missing.push(asked.get(url) ?? url); };
    const loader = new GLTFLoader(manager);
    if (meshopt) loader.setMeshoptDecoder(meshopt.MeshoptDecoder);
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      try { loader.parse(buf, MODEL_BASE, resolve, reject); } catch (e) { reject(e); }
    });
    const scene = gltf.scene ?? gltf.scenes?.[0];
    if (!scene) throw emptyModelError();
    return { model: scene, missing: [...new Set(missing)] };
  }

  if (format === 'stl') {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    const geom = new STLLoader().parse(buf);
    // Exporters leave zero normals more often than not; a non-indexed
    // geometry gets flat face normals back, which is what an STL is.
    geom.computeVertexNormals();
    const colored = !!geom.getAttribute('color');
    const mat = neutralMaterial(THREE, colored);
    const alpha = (geom as BufferGeometry & { alpha?: number }).alpha;
    if (colored && alpha !== undefined && alpha < 1) { mat.opacity = alpha; mat.transparent = true; }
    const group = new THREE.Group();
    group.add(new THREE.Mesh(geom, mat));
    // CAD and 3D printing are Z-up; three.js is Y-up. Without this, a
    // figurine lies on its back.
    group.rotation.x = -Math.PI / 2;
    return { model: group, missing: [] };
  }

  if (format === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const group = new OBJLoader().parse(new TextDecoder().decode(buf));
    // No .mtl is read: every surface gets the neutral material (vertex
    // colours kept), lines and points keep theirs, recoloured per theme.
    group.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        const old = mesh.material;
        mesh.material = neutralMaterial(THREE, !!mesh.geometry.getAttribute('color'));
        (Array.isArray(old) ? old : [old]).forEach((m) => m.dispose());
      } else {
        forEachMaterial(o, (m) => { m.userData.neutral = true; });
      }
    });
    return { model: group, missing: [] };
  }

  const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
  const geom = new PLYLoader().parse(buf);
  const faces = plyFaceCount(new Uint8Array(buf));
  const colored = !!geom.getAttribute('color');
  if (faces === 0 || (faces === null && !geom.index)) {
    geom.computeBoundingSphere();
    const count = geom.getAttribute('position')?.count ?? 0;
    const mat = new THREE.PointsMaterial({
      size: pointSize(geom.boundingSphere?.radius ?? 1, count),
      sizeAttenuation: true, vertexColors: colored,
      // A scan's colours are the data: shown as captured, not tone-mapped.
      toneMapped: false,
    });
    mat.userData.neutral = true;
    return { model: new THREE.Points(geom, mat), missing: [] };
  }
  if (!geom.getAttribute('normal')) geom.computeVertexNormals();
  return { model: new THREE.Mesh(geom, neutralMaterial(THREE, colored)), missing: [] };
}

function engineError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/webgl/i.test(msg)) return 'WebGL is unavailable in this browser, so 3D models cannot be shown here';
  return `could not start the 3D viewer: ${msg}`;
}

// ── The pane ────────────────────────────────────────────────────────────────

type Info = { stats: string; dims: string; missing: string[] };

export default function ModelViewer({ vpsId, root, path, name, url, rev, active }: ByteViewerProps) {
  const format = modelFormat(name);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(false);
  const [spin, setSpin] = useState(false);
  // The URL whose model is on screen: a reload of the SAME file (a new
  // `rev`) keeps the reader's camera, another file is framed afresh.
  const shownUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!host || !format) return;
    let alive = true;
    let made: Stage | null = null;
    loadEngine().then((engine) => {
      if (!alive) return;
      made = createStage(engine, host);
      setStage(made);
    }).catch((e: unknown) => { if (alive) setErr(engineError(e)); });
    return () => {
      alive = false;
      made?.dispose();
      setStage((s) => (s === made ? null : s));
      shownUrl.current = null;
    };
  }, [host, format]);

  useEffect(() => { stage?.setActive(active); }, [stage, active]);
  useEffect(() => { stage?.set({ wire }); }, [stage, wire]);
  useEffect(() => { stage?.set({ grid }); }, [stage, grid]);
  useEffect(() => { stage?.set({ spin }); }, [stage, spin]);

  useEffect(() => {
    if (!stage || !format) return;
    const ctrl = new AbortController();
    let alive = true;
    setErr(null);
    setProgress({ loaded: 0, total: 0 });
    const modelAbs = modelAbsPath(root, path);
    const locate = (uri: string): string | null => {
      const abs = resolveModelUri(modelAbs, uri);
      if (!abs) return null;
      const r = rootedPath(root, abs);
      return api.fsFileUrl(vpsId, r.root, r.path, { inline: isInlineImage(abs) });
    };
    let lastTick = 0;
    (async () => {
      const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
      const buf = await readFileBytes(res, (loaded, total) => {
        // A state update per network chunk would re-render hundreds of times.
        const now = performance.now();
        if (alive && now - lastTick > 100) { lastTick = now; setProgress({ loaded, total }); }
      });
      if (!alive) return;
      const parsed = await parseModel(stage.engine.THREE, format, buf, locate);
      if (!alive) { stage.discard(parsed.model); return; }
      const shown = stage.show(parsed.model, shownUrl.current === url);
      shownUrl.current = url;
      setInfo({
        stats: formatModelStats({ ...shown, bytes: buf.byteLength }),
        dims: formatDims(shown.size),
        missing: parsed.missing,
      });
    })().catch((e: unknown) => {
      if (alive && !ctrl.signal.aborted) setErr(describeModelError(e, format));
    }).finally(() => {
      if (alive) setProgress(null);
    });
    return () => { alive = false; ctrl.abort(); };
  }, [stage, format, url, rev, vpsId, root, path]);

  const loadingText = progress && (progress.total > 0
    ? `loading ${Math.round((progress.loaded / progress.total) * 100)}%`
    : progress.loaded > 0 ? `loading ${formatBytes(progress.loaded)}` : 'loading…');
  const ready = !!info && !!stage;
  const missing = info?.missing ?? [];

  if (!format) {
    const ext = /\.([^./]+)$/.exec(name)?.[1];
    return (
      <div className="mdlv">
        <div className="dvm-note err mdlv-note">
          {ext ? `.${ext} files` : 'this file'} cannot be shown as a 3D model (glb, gltf, stl, obj, ply)
        </div>
      </div>
    );
  }

  return (
    <div className="mdlv">
      <div className="viewer-bar mdlv-bar">
        {info && <span className="viewer-bar-note" title={`Size ${info.dims} (model units)`}>{info.stats}</span>}
        {missing.length > 0 && (
          <span className="viewer-bar-note warn" title={missing.join('\n')}>
            {missing.length} file{missing.length === 1 ? '' : 's'} not found
          </span>
        )}
        {loadingText && info && <span className="viewer-bar-note">{loadingText}</span>}
        <span className="viewer-bar-spacer" />
        <button type="button" disabled={!ready} onClick={() => stage?.resetView()} title="Frame the whole model again">
          Reset view
        </button>
        <button type="button" disabled={!ready} className={wire ? 'on' : ''} onClick={() => setWire((v) => !v)}
                title="Show the triangle edges">
          Wireframe
        </button>
        <button type="button" disabled={!ready} className={grid ? 'on' : ''} onClick={() => setGrid((v) => !v)}
                title="A floor grid under the model">
          Grid
        </button>
        <button type="button" disabled={!ready} className={spin ? 'on' : ''} onClick={() => setSpin((v) => !v)}
                title="Turn the model slowly">
          Auto-rotate
        </button>
      </div>
      {err && <div className="dvm-note err mdlv-note">{err}</div>}
      <div className="mdlv-stage" aria-label={name}>
        <div className="mdlv-host" ref={setHost} />
        {!info && !err && <div className="mdlv-overlay">{loadingText || 'loading…'}</div>}
      </div>
    </div>
  );
}
