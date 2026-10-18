// Fluid motion, after Apple's "Designing Fluid Interfaces" (via the Apple motion guidance skill):
// springs instead of fixed-duration transitions, so motion starts from the live value, inherits the finger's
// velocity, and can be grabbed and redirected at any instant.

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Animate a number with a spring. Apple's designer-friendly parameters:
 *   damping  — 1.0 = critically damped (no overshoot); ~0.8 = a little bounce (only after a flick)
 *   response — seconds to (mostly) reach the target; not a duration — settle time emerges from physics
 * Returns { stop() → current value } so a new gesture can take over mid-flight.
 */
export function spring({ from, to, velocity = 0, damping = 1, response = 0.35, onUpdate, onDone }) {
  if (reducedMotion()) { onUpdate(to); onDone?.(); return { stop: () => to, get value() { return to; } }; }
  const k = (2 * Math.PI / response) ** 2; // stiffness (mass = 1)
  const c = (4 * Math.PI * damping) / response; // damping coefficient
  let x = from; let v = velocity; let last = performance.now(); let raf = 0; let done = false;
  const step = (now) => {
    let dt = Math.min(0.064, (now - last) / 1000);
    last = now;
    // Sub-step for stability at low frame rates.
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240);
      const a = -k * (x - to) - c * v;
      v += a * h; x += v * h; dt -= h;
    }
    if (Math.abs(x - to) < 0.4 && Math.abs(v) < 8) { x = to; onUpdate(x); done = true; onDone?.(); return; }
    onUpdate(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return { stop() { cancelAnimationFrame(raf); done = true; return x; }, get value() { return x; }, get done() { return done; } };
}

/** Where a flick would come to rest (Apple's projection, exponential decay; d≈0.998 ≈ scroll feel). */
export const project = (velocity, d = 0.998) => ((velocity / 1000) * d) / (1 - d);

/** Soft boundary: the further past the edge, the less the element follows. */
export const rubberband = (overshoot, dimension, constant = 0.55) => (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));

/** Release velocity from the last ~100ms of pointer samples (px/s). */
export function velocityTracker() {
  const samples = [];
  return {
    add(pos, t = performance.now()) { samples.push({ pos, t }); while (samples.length > 2 && t - samples[0].t > 100) samples.shift(); },
    velocity() {
      if (samples.length < 2) return 0;
      const a = samples[0]; const b = samples[samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      return dt > 0 ? (b.pos - a.pos) / dt : 0;
    },
    reset() { samples.length = 0; },
  };
}
