/**
 * The aurora: Conductor's voice drawn as light. One engine holds the current colours and
 * energy and eases them toward the phase's palette, so state changes blend instead of
 * snapping. The bottom band and the pop-out orb both draw from it.
 */

export type Phase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'muted' | 'closing';

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Four colours per phase; blobs cycle through them. */
const PALETTE: Record<Phase, RGB[]> = {
  connecting: ['#ffb547', '#ff8a3d', '#ffd27a', '#f59e0b'].map(hex),
  listening: ['#19d3c5', '#1fa9e8', '#2ee6d6', '#3b7bf6'].map(hex),
  hearing: ['#5ff5e3', '#4fd6ff', '#b4f6ff', '#2fc8ff'].map(hex),
  thinking: ['#7c5cff', '#a78bfa', '#5b6cff', '#c084fc'].map(hex),
  speaking: ['#9b5cff', '#e45cff', '#ff6fb5', '#b77bff'].map(hex),
  muted: ['#5b6170', '#3d424d', '#737a88', '#4a4f5b'].map(hex),
  closing: ['#5b6170', '#3d424d', '#737a88', '#4a4f5b'].map(hex),
};

/** How bright the phase is at rest, how much the voice level adds, how fast it drifts. */
const ENERGY: Record<Phase, { base: number; gain: number; drift: number }> = {
  connecting: { base: 0.42, gain: 0, drift: 1.6 },
  listening: { base: 0.38, gain: 0.35, drift: 0.7 },
  hearing: { base: 0.55, gain: 0.6, drift: 1.2 },
  thinking: { base: 0.5, gain: 0, drift: 1.4 },
  speaking: { base: 0.55, gain: 0.7, drift: 1.1 },
  muted: { base: 0.22, gain: 0, drift: 0.35 },
  closing: { base: 0, gain: 0, drift: 0.5 },
};

const BLOBS = 9;
/** Colour and energy ease with this time constant, in ms. */
const EASE_MS = 420;

export class Aurora {
  private colors: RGB[] = PALETTE.connecting.map((c) => [...c] as RGB);
  private energy = 0;
  private drift = 1;
  private sweep = 0; // 0..1, how much the thinking sweep shows
  private clock = 0; // drift-scaled time, so speed changes don't jump positions
  private last = 0;
  /** Opacity envelope for opening/closing. */
  private presence = 0;
  still = false;

  /** Advance toward `phase`; `level` is the loudness (0..1) of whoever has the floor. */
  update(phase: Phase, level: number, t: number, present: boolean): void {
    if (!Number.isFinite(level)) level = 0;
    // Clamp: frames can come from two windows (page and pop-out) whose clocks have different origins.
    const dt = this.last ? Math.max(0, Math.min(100, t - this.last)) : 16;
    this.last = t;
    const k = this.still ? 1 : 1 - Math.exp(-dt / EASE_MS);
    const target = PALETTE[phase];
    for (let i = 0; i < 4; i++) for (let c = 0; c < 3; c++) this.colors[i]![c]! += (target[i]![c]! - this.colors[i]![c]!) * k;
    const e = ENERGY[phase];
    const want = Math.min(1, e.base + e.gain * level);
    // Rise quickly with the voice, fall back gently.
    const ke = this.still ? 1 : 1 - Math.exp(-dt / (want > this.energy ? 90 : 380));
    this.energy += (want - this.energy) * ke;
    this.drift += (e.drift - this.drift) * k;
    this.sweep += ((phase === 'thinking' ? 1 : 0) - this.sweep) * k;
    this.presence += ((present ? 1 : 0) - this.presence) * (this.still ? 1 : 1 - Math.exp(-dt / 260));
    if (!this.still) this.clock += dt * this.drift;
  }

  private rgba(i: number, a: number): string {
    const [r, g, b] = this.colors[((i % 4) + 4) % 4]!;
    return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
  }

  /** CSS colour for text and accents, following the palette. */
  accent(i = 0, a = 1): string { return this.rgba(i, a); }

  /** Palette colour at a continuous position `u` (wraps every 4), blended between neighbours. */
  private mix(u: number, a: number): string {
    const i = Math.floor(u);
    const f = u - i;
    const c0 = this.colors[((i % 4) + 4) % 4]!;
    const c1 = this.colors[(((i + 1) % 4) + 4) % 4]!;
    const ch = (k: number) => (c0[k]! + (c1[k]! - c0[k]!) * f) | 0;
    return `rgba(${ch(0)},${ch(1)},${ch(2)},${a})`;
  }

  /** The band: a continuous ribbon of light along the bottom edge, with brighter crests drifting through it. */
  drawBand(g: CanvasRenderingContext2D, w: number, h: number): void {
    g.clearRect(0, 0, w, h);
    const p = this.presence;
    if (p < 0.01 || !(w > 0 && h > 0)) return;
    const e = this.energy;
    const t = this.clock;
    const horizon = h - 34; // top edge of the control strip
    const floor = horizon + 4; // the light pools on the horizon, leaving the strip's text readable

    // Ribbon: colours flowing sideways, fading upward.
    const top = floor - (46 + 60 * e);
    const ribbon = g.createLinearGradient(0, 0, w, 0);
    for (let k = 0; k <= 8; k++) ribbon.addColorStop(k / 8, this.mix(k * 0.55 + t * 0.00012, (0.3 + 0.45 * e) * p));
    g.fillStyle = ribbon;
    g.fillRect(0, top, w, h - top);
    g.globalCompositeOperation = 'destination-in';
    const fade = g.createLinearGradient(0, top, 0, h);
    const at = (y: number) => (y - top) / (h - top);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(at(horizon) * 0.6, 'rgba(0,0,0,0.5)');
    fade.addColorStop(at(horizon), 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0.3)');
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h);

    // Crests: overlapping soft lights that swell with the voice.
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < BLOBS; i++) {
      const speed = 0.000016 + i * 0.000004;
      const x = ((((i / BLOBS + t * speed) % 1) + 1) % 1) * (w * 1.4) - w * 0.2 + Math.sin(t * 0.00029 + i * 2.1) * w * 0.05;
      const rx = w * (0.17 + 0.06 * Math.sin(t * 0.00021 + i * 1.3));
      const ry = (22 + 92 * e) * (0.6 + 0.4 * Math.sin(t * 0.0011 + i * 1.7));
      blob(g, x, floor, rx, ry, this.rgba(i, (0.16 + 0.34 * e) * p));
    }
    if (this.sweep > 0.02) {
      const s = ((t * 0.00045) % 1.3) - 0.15;
      blob(g, s * w, floor, w * 0.14, 70 + 40 * e, `rgba(236,228,255,${0.32 * this.sweep * p})`);
    }
    // The horizon: a thin line of light along the top of the control strip.
    const line = g.createLinearGradient(0, 0, w, 0);
    for (let k = 0; k <= 8; k++) line.addColorStop(k / 8, this.mix(k * 0.55 + t * 0.00012 + 0.5, (0.45 + 0.55 * e) * p));
    g.fillStyle = line;
    g.fillRect(0, horizon, w, 1);
    g.globalCompositeOperation = 'source-over';
  }

  /** The pop-out orb: a small sphere of the same light. */
  drawOrb(g: CanvasRenderingContext2D, size: number, level: number): void {
    const c = size / 2;
    const e = this.energy;
    const t = this.clock;
    // Capped so the swollen orb and its halo always fade out inside the canvas.
    const r = Math.min(size * 0.3 * (1 + 0.06 * e + 0.1 * level), c * 0.66);
    g.clearRect(0, 0, size, size);
    if (!(r > 0) || !Number.isFinite(r)) return; // not laid out yet
    g.globalCompositeOperation = 'lighter';
    // Halo.
    const halo = g.createRadialGradient(c, c, r * 0.6, c, c, Math.min(r * 1.65, c * 0.99));
    halo.addColorStop(0, this.rgba(1, 0.35 * this.presence * (0.5 + e)));
    halo.addColorStop(1, this.rgba(1, 0));
    g.fillStyle = halo;
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'source-over';
    // Body.
    g.save();
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#0b0c12';
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const a = t * (0.0006 + i * 0.00017) + (i * Math.PI) / 2;
      const d = r * (0.38 + 0.12 * Math.sin(t * 0.0011 + i));
      blob(g, c + Math.cos(a) * d, c + Math.sin(a) * d, r * (0.9 + 0.2 * e), r * (0.9 + 0.2 * e), this.rgba(i, (0.45 + 0.45 * e) * this.presence));
    }
    if (this.sweep > 0.02) {
      const a = t * 0.004;
      blob(g, c + Math.cos(a) * r * 0.55, c + Math.sin(a) * r * 0.55, r * 0.5, r * 0.5, `rgba(240,232,255,${0.4 * this.sweep})`);
    }
    g.globalCompositeOperation = 'source-over';
    // Glassy top highlight.
    const hl = g.createRadialGradient(c - r * 0.3, c - r * 0.45, 0, c - r * 0.3, c - r * 0.45, r * 0.9);
    hl.addColorStop(0, 'rgba(255,255,255,0.22)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl;
    g.fillRect(0, 0, size, size);
    g.restore();
  }
}

/** A soft elliptical light. */
function blob(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string) {
  g.save();
  g.translate(x, y);
  g.scale(1, ry / rx);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  grad.addColorStop(0, color);
  grad.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
  g.fillStyle = grad;
  g.fillRect(-rx, -rx, rx * 2, rx * 2);
  g.restore();
}

/** Match a canvas's backing store to its CSS size. Returns the CSS size. */
export function fit(cv: HTMLCanvasElement, win: Window = window): { w: number; h: number } {
  const dpr = win.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  cv.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
