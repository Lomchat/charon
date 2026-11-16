'use client';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CircleMarkerOptions, GeoJSON as GeoJsonLayer, Layer, Map as LeafletMap, PathOptions, PopupOptions, TileLayer,
} from 'leaflet';
import type { TextViewerProps } from './fileViews';
import {
  boundsMoved, geoBounds, geoFormatOf, geoStats, geoSummary, parseGeoText, popupModel, xmlErrorMessage,
  GeoParseError, type GeoBounds, type GeoElement, type GeoFeature, type GeoFeatureCollection, type GeoStats,
  type ParsedGeo,
} from './geoFormats';

// The map view of a .geojson / .gpx / .kml file (§14.112). The pane's TEXT is
// the source — unsaved edits included — so a fix in the editor shows here.
// Lazy twice over, like the PDF pane: this module is a lazy chunk (app/dynamic.tsx),
// and Leaflet itself is imported only once a map file is actually opened.
// The file is untrusted: no property string ever reaches innerHTML.

type Leaflet = typeof import('leaflet');

let leafletPromise: Promise<Leaflet> | null = null;
function loadLeaflet(): Promise<Leaflet> {
  // ESM build = named exports; a CJS interop wraps the same object in `default`.
  leafletPromise ??= import('leaflet')
    .then((m) => (m as Leaflet & { default?: Leaflet }).default ?? m)
    .catch((e: unknown) => { leafletPromise = null; throw e; });
  return leafletPromise;
}

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// Leaflet writes attributions as HTML: these two are constants, never file data.
// A plain link would navigate the hub away; they open beside it.
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
const LEAFLET_PREFIX = '<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>';
/** Per browser: hiding the basemap is also how a reader keeps tile requests off OSM. */
const BASEMAP_KEY = 'hub.files.geoBasemap';
/** A lone point fits to street level, not to the tiles' last zoom. */
const FIT_MAX_ZOOM = 16;
/** While shown, edits re-render after a pause, not per keystroke. */
const REPARSE_MS = 250;

const LINE: PathOptions = { weight: 3, opacity: 0.95, fillOpacity: 0.18, lineCap: 'round', lineJoin: 'round' };
const CASING: PathOptions = { weight: 6.5, opacity: 0.6, fill: false, lineCap: 'round', lineJoin: 'round' };
const POINT: CircleMarkerOptions = { radius: 5, weight: 2, opacity: 1, fillOpacity: 1 };
const POPUP: PopupOptions = { maxWidth: 320, minWidth: 120, maxHeight: 300, autoPanPadding: [16, 16] };

/** Canvas/SVG styles are not CSS: the theme's tokens are read and handed over. */
type Palette = { ink: string; halo: string };
function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const token = (n: string) => css.getPropertyValue(n).trim();
  return { ink: token('--accent-strong') || token('--accent') || 'currentColor', halo: token('--bg') || 'transparent' };
}

function readBasemapPref(): boolean {
  try { return localStorage.getItem(BASEMAP_KEY) !== '0'; } catch { return true; }
}

function parseXml(text: string): GeoElement {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  // Chrome inserts <parsererror> into a partial tree; Firefox makes it the root.
  const bad = doc.getElementsByTagNameNS('*', 'parsererror')[0];
  if (bad) throw new GeoParseError(xmlErrorMessage(bad.textContent ?? ''));
  return doc.documentElement;
}

type Parsed =
  | { ok: true; data: ParsedGeo; stats: GeoStats; bounds: GeoBounds | null }
  | { ok: false; error: string };

function parse(text: string, name: string): Parsed {
  const format = geoFormatOf(name);
  if (!format) return { ok: false, error: `${name} is not a GeoJSON, GPX or KML file` };
  try {
    const data = parseGeoText(text, format, parseXml);
    return { ok: true, data, stats: geoStats(data.collection), bounds: geoBounds(data.collection) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Points last: on one canvas, the last drawn is on top and gets the click. */
function drawOrder(features: GeoFeature[]): GeoFeatureCollection {
  const isPoint = (f: GeoFeature) => f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint';
  return { type: 'FeatureCollection', features: [...features.filter((f) => !isPoint(f)), ...features.filter(isPoint)] };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** Built on open, from text nodes only. */
function popupNode(f: GeoFeature): HTMLElement {
  const m = popupModel(f);
  const box = node('div', 'geov-pop');
  box.append(node('div', 'geov-pop-title', m.title));
  const list = (rows: [string, string][], cls: string) => {
    const dl = node('dl', cls);
    for (const [k, v] of rows) dl.append(node('dt', undefined, k), node('dd', undefined, v));
    return dl;
  };
  if (m.rows.length) box.append(list(m.rows, 'geov-pop-props'));
  if (m.more) box.append(node('div', 'geov-pop-more', `… ${m.more} more`));
  if (m.facts.length) box.append(list(m.facts, 'geov-pop-facts'));
  return box;
}

/**
 * Styles by layer KIND, not by feature: a GeometryCollection mixes points
 * and lines under one feature, and Leaflet's `style` option would give its
 * points the line style.
 */
function paint(L: Leaflet, layer: Layer, pal: Palette, casing: boolean): void {
  if (layer instanceof L.CircleMarker) {
    if (!casing) layer.setStyle({ ...POINT, color: pal.halo, fillColor: pal.ink });
  } else if (layer instanceof L.Path) {
    layer.setStyle(casing ? { ...CASING, color: pal.halo } : { ...LINE, color: pal.ink, fillColor: pal.ink });
  } else if (layer instanceof L.LayerGroup) {
    layer.eachLayer((child) => paint(L, child, pal, casing));
  }
}

type Leaf = { L: Leaflet; map: LeafletMap; tiles: TileLayer };
type Drawn = { casing: GeoJsonLayer; main: GeoJsonLayer };

export default function GeoViewer({ name, text, active }: TextViewerProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [drawErr, setDrawErr] = useState<string | null>(null);
  const [basemap, setBasemap] = useState(readBasemapPref);
  const [tilesFailing, setTilesFailing] = useState(false);
  const [src, setSrc] = useState(text);
  const leafRef = useRef<Leaf | null>(null);
  const drawnRef = useRef<Drawn | null>(null);
  const paletteRef = useRef<Palette>({ ink: 'currentColor', halo: 'transparent' });
  // Bounds waiting for a visible, sized map; and the ones it was last fitted
  // to — the reference a re-render compares against before moving the view.
  const pendingFitRef = useRef<GeoBounds | null>(null);
  const fittedRef = useRef<GeoBounds | null>(null);
  const shownRef = useRef(active);

  // A hidden pane does not re-parse on every edit made elsewhere (§14.111):
  // it catches up once, when shown again.
  useEffect(() => {
    const justShown = active && !shownRef.current;
    shownRef.current = active;
    if (!active || text === src) return;
    if (justShown) { setSrc(text); return; }
    const t = setTimeout(() => setSrc(text), REPARSE_MS);
    return () => clearTimeout(t);
  }, [active, text, src]);

  const parsed = useMemo(() => parse(src, name), [src, name]);

  const tryFit = useCallback((animate: boolean) => {
    const leaf = leafRef.current;
    const b = pendingFitRef.current;
    if (!leaf || !b) return;
    leaf.map.invalidateSize({ pan: false });
    const size = leaf.map.getSize();
    // Hidden behind an error note (display:none): fit once it is shown.
    if (size.x < 2 || size.y < 2) return;
    pendingFitRef.current = null;
    fittedRef.current = b;
    const pad = Math.round(Math.min(32, size.x / 8, size.y / 8));
    leaf.map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [pad, pad], maxZoom: FIT_MAX_ZOOM, animate });
  }, []);

  useEffect(() => {
    if (!host) return;
    let alive = true;
    let map: LeafletMap | null = null;
    loadLeaflet().then((L) => {
      if (!alive) return;
      const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
      map = L.map(host, {
        // One canvas for every path: a GPX track is thousands of vertices.
        // `tolerance` widens the hit area so a finger can still pick a line.
        renderer: L.canvas({ padding: 0.5, tolerance: coarse ? 10 : 4 }),
        minZoom: 1,
        maxZoom: 20,
      }).setView([20, 0], 2);
      map.attributionControl.setPrefix(LEAFLET_PREFIX);
      L.control.scale({ imperial: false }).addTo(map);
      const tiles = L.tileLayer(OSM_TILES, { maxNativeZoom: 19, maxZoom: 20, attribution: OSM_ATTRIBUTION });
      // An offline hub (or a blocked tile server) must not look like an empty file.
      tiles.on('tileerror', () => setTilesFailing(true));
      tiles.on('tileload', () => setTilesFailing(false));
      paletteRef.current = readPalette(host);
      leafRef.current = { L, map, tiles };
      setReady(true);
    }).catch((e: unknown) => {
      if (alive) setLoadErr(`could not load the map: ${e instanceof Error ? e.message : String(e)}`);
    });
    return () => {
      alive = false;
      map?.remove();
      leafRef.current = null;
      drawnRef.current = null;
      fittedRef.current = null;
      setReady(false);
    };
  }, [host]);

  useEffect(() => {
    const leaf = leafRef.current;
    if (!ready || !leaf) return;
    if (basemap) leaf.tiles.addTo(leaf.map);
    else { leaf.tiles.remove(); setTilesFailing(false); }
  }, [ready, basemap]);

  useEffect(() => {
    const leaf = leafRef.current;
    if (!ready || !leaf || !parsed.ok) return;
    const { L, map } = leaf;
    const fc = drawOrder(parsed.data.collection.features);
    let next: Drawn;
    try {
      next = {
        // A halo in the page's background colour under every line keeps a
        // pale accent legible on light tiles, and a dark one on dark.
        casing: L.geoJSON(fc, { interactive: false, pointToLayer: () => L.layerGroup() }),
        main: L.geoJSON(fc, {
          pointToLayer: (_f, latlng) => L.circleMarker(latlng),
          onEachFeature: (f, layer) => { layer.bindPopup(() => popupNode(f as unknown as GeoFeature), POPUP); },
        }),
      };
    } catch (e) {
      setDrawErr(`could not draw this file: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const prev = drawnRef.current;
    prev?.casing.remove();
    prev?.main.remove();
    paint(L, next.casing, paletteRef.current, true);
    paint(L, next.main, paletteRef.current, false);
    next.casing.addTo(map);
    next.main.addTo(map);
    drawnRef.current = next;
    setDrawErr(null);
    // A save that nudges a vertex keeps the reader's view; new data elsewhere moves it.
    if (boundsMoved(fittedRef.current, parsed.bounds)) {
      pendingFitRef.current = parsed.bounds;
      tryFit(false);
    }
  }, [ready, parsed, tryFit]);

  // Shown again: the pane may have been resized while hidden. Hidden: the
  // map's arrow/± keys must not act from an invisible, still-focused pane.
  useEffect(() => {
    const map = leafRef.current?.map;
    if (!ready || !map) return;
    if (active) {
      map.invalidateSize();
      map.keyboard.enable();
      tryFit(false);
    } else {
      map.keyboard.disable();
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && map.getContainer().contains(focused)) focused.blur();
    }
  }, [ready, active, tryFit]);

  useEffect(() => {
    if (!ready || !host) return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        leafRef.current?.map.invalidateSize();
        tryFit(false);
      });
    });
    ro.observe(host);
    return () => { ro.disconnect(); cancelAnimationFrame(frame); };
  }, [ready, host, tryFit]);

  // A theme switch (§14.99) reaches the canvas only through a repaint.
  useEffect(() => {
    if (!ready || !host) return;
    const mo = new MutationObserver(() => {
      const leaf = leafRef.current;
      const drawn = drawnRef.current;
      paletteRef.current = readPalette(host);
      if (!leaf || !drawn) return;
      paint(leaf.L, drawn.casing, paletteRef.current, true);
      paint(leaf.L, drawn.main, paletteRef.current, false);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [ready, host]);

  const fit = useCallback(() => {
    if (!parsed.ok || !parsed.bounds) return;
    pendingFitRef.current = parsed.bounds;
    tryFit(true);
  }, [parsed, tryFit]);

  const toggleBasemap = () => {
    const next = !basemap;
    setBasemap(next);
    try { localStorage.setItem(BASEMAP_KEY, next ? '1' : '0'); } catch { /* private mode: this tab only */ }
  };

  const format = geoFormatOf(name);
  const err = loadErr ?? (parsed.ok ? drawErr : parsed.error);
  const empty = parsed.ok && !parsed.data.collection.features.length;
  const summary = parsed.ok && format ? geoSummary(parsed.stats, format) : '';
  const skipped = parsed.ok ? parsed.data.skipped : 0;
  const canFit = ready && parsed.ok && !!parsed.bounds && !err;

  return (
    <div className="geov">
      <div className="viewer-bar">
        {summary && <span className="viewer-bar-note">{summary}</span>}
        {skipped > 0 && (
          <span className="viewer-bar-note warn" title="Entries whose coordinates could not be read are not drawn">
            {skipped} invalid {skipped === 1 ? 'entry' : 'entries'} skipped
          </span>
        )}
        {basemap && tilesFailing && !err && (
          <span className="viewer-bar-note warn" title="tile.openstreetmap.org did not answer">basemap unavailable</span>
        )}
        <span className="viewer-bar-spacer" />
        <button type="button" onClick={fit} disabled={!canFit} title="Zoom to the whole file">Fit</button>
        <button type="button" className={basemap ? 'on' : ''} onClick={toggleBasemap}
                title={basemap ? 'Hide the OpenStreetMap basemap (data only)' : 'Show the OpenStreetMap basemap (tiles load from tile.openstreetmap.org)'}>
          Basemap
        </button>
      </div>
      {err && <div className="dvm-note err">{err}</div>}
      {!err && empty && <div className="dvm-note">nothing to draw — this file has no features with coordinates</div>}
      {/* The inner div is Leaflet's: React must never rewrite its className. */}
      <div className={`geov-stage${err || empty ? ' off' : ''}`}>
        <div ref={setHost} className="geov-map" aria-label={name} />
      </div>
    </div>
  );
}
