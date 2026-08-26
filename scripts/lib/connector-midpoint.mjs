/**
 * The world point where a connector's marker sits.
 *
 * Mirrors `resolveAnchor` and `connectorPath` in the renderer: each end is the
 * border point facing the other table's centre, the line leaves along that
 * edge's normal as a cubic, and the marker sits at t = 0.5. Shared by the
 * browser checks so the two cannot drift apart — they already had.
 *
 * Runs inside `page.evaluate`, so it takes plain transforms rather than reaching
 * for anything in the page.
 */
export const connectorMidpoint = (fromTransform, toTransform, options = {}) => {
  const gap = options.gap ?? 4;
  const tension = options.tension ?? 0.42;
  const minReach = options.minReach ?? 36;
  const maxReach = options.maxReach ?? 320;
  const maxFraction = options.maxFraction ?? 0.6;

  const rect = (t) => ({
    cx: t.x + t.width / 2,
    cy: t.y + t.height / 2,
    hw: t.width / 2,
    hh: t.height / 2,
  });
  const border = (a, b) => {
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const horizontal = dx === 0 ? Infinity : a.hw / Math.abs(dx);
    const vertical = dy === 0 ? Infinity : a.hh / Math.abs(dy);
    const scale = Math.min(horizontal, vertical);
    const throughSide = horizontal <= vertical;
    return {
      x: a.cx + dx * scale,
      y: a.cy + dy * scale,
      nx: throughSide ? Math.sign(dx) : 0,
      ny: throughSide ? 0 : Math.sign(dy),
    };
  };

  const from = rect(fromTransform);
  const to = rect(toTransform);
  const start = border(from, to);
  const end = border(to, from);
  const a = { x: start.x + start.nx * gap, y: start.y + start.ny * gap };
  const d = { x: end.x + end.nx * gap, y: end.y + end.ny * gap };
  const span = Math.hypot(d.x - a.x, d.y - a.y);
  // Capped against the span, or a short connector would loop out and back.
  const reach = Math.min(span * maxFraction, maxReach, Math.max(minReach, span * tension));
  const b = { x: a.x + start.nx * reach, y: a.y + start.ny * reach };
  const c = { x: d.x + end.nx * reach, y: d.y + end.ny * reach };
  return {
    x: (a.x + 3 * b.x + 3 * c.x + d.x) / 8,
    y: (a.y + 3 * b.y + 3 * c.y + d.y) / 8,
  };
};
