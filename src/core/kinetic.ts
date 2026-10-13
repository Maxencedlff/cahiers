/**
 * Defilement au doigt avec inertie (lot stylet), logique pure.
 *
 * La vitesse est mesuree sur les ~100 dernieres ms du geste, puis decroit
 * de facon exponentielle a chaque image. L'animation est courte (elle
 * s'arrete sous MIN_SPEED, ou au bout de MAX_MS) et s'arrete au moindre
 * appui : aucune boucle permanente (section 9, batterie). Le moteur
 * d'images (requestAnimationFrame) est dans l'interface (canvas.ts).
 * Tests : src/tests/stylet.test.ts.
 */

/** Fenetre de mesure de la vitesse (ms). */
export const VELOCITY_WINDOW_MS = 100;
/** Constante de temps de la decroissance (ms) : ~0,6 s de glisse visible. */
export const DECAY_MS = 325;
/** Sous cette vitesse (px/ms), l'inertie s'arrete. */
export const MIN_SPEED = 0.02;
/** Vitesse de lancement minimale (px/ms) : un doigt pose puis leve ne lance rien. */
export const FLING_START = 0.25;
/** Vitesse plafonnee (px/ms). */
export const MAX_SPEED = 8;
/** Duree maximale d'une glisse (ms). */
export const MAX_MS = 2500;
/** Doigt immobile avant le lever au-dela de ce delai : pas d'inertie. */
export const REST_MS = 60;

interface Sample { t: number; x: number; y: number }

/** Suit les positions du doigt et donne sa vitesse recente. */
export class VelocityTracker {
  private samples: Sample[] = [];

  reset(): void { this.samples = []; }

  add(t: number, x: number, y: number): void {
    this.samples.push({ t, x, y });
    // On ne garde que la fenetre utile (et deux points au moins).
    while (this.samples.length > 2 && t - this.samples[0].t > VELOCITY_WINDOW_MS) this.samples.shift();
  }

  /**
   * Vitesse (px/ms) sur la fenetre, a l'instant `now` (le lever). Nulle si
   * le doigt s'est arrete avant de se lever.
   */
  velocity(now: number): { vx: number; vy: number } {
    const s = this.samples;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const last = s[s.length - 1];
    if (now - last.t > REST_MS) return { vx: 0, vy: 0 };
    let first = s[0];
    for (const q of s) if (last.t - q.t <= VELOCITY_WINDOW_MS) { first = q; break; }
    const dt = last.t - first.t;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return clampSpeed((last.x - first.x) / dt, (last.y - first.y) / dt);
  }
}

function clampSpeed(vx: number, vy: number): { vx: number; vy: number } {
  const s = Math.hypot(vx, vy);
  if (s <= MAX_SPEED) return { vx, vy };
  return { vx: (vx / s) * MAX_SPEED, vy: (vy / s) * MAX_SPEED };
}

/** Une glisse lancee : deplacement de chaque image jusqu'a l'arret. */
export class Fling {
  private vx: number;
  private vy: number;
  private elapsed = 0;

  constructor(vx: number, vy: number) {
    const v = clampSpeed(vx, vy);
    this.vx = v.vx;
    this.vy = v.vy;
  }

  /** Vaut-il la peine de lancer une glisse a cette vitesse ? */
  static worth(vx: number, vy: number): boolean {
    return Math.hypot(vx, vy) >= FLING_START;
  }

  get done(): boolean {
    return this.elapsed >= MAX_MS || Math.hypot(this.vx, this.vy) < MIN_SPEED;
  }

  /**
   * Avance de `dt` ms : deplacement (px) integre exactement sur
   * l'intervalle, vitesse decrue. Rend {0,0} une fois arretee.
   */
  step(dt: number): { dx: number; dy: number } {
    if (this.done || dt <= 0) return { dx: 0, dy: 0 };
    const d = Math.min(dt, 64); // image tres en retard : pas de saut
    const f = Math.exp(-d / DECAY_MS);
    const k = DECAY_MS * (1 - f);
    const out = { dx: this.vx * k, dy: this.vy * k };
    this.vx *= f;
    this.vy *= f;
    this.elapsed += d;
    return out;
  }
}
