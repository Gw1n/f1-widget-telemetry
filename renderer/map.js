'use strict';

/** Track-map geometry shared by the main window and the overlay. */
const TrackMap = (() => {
  /** Fit the track bounds into w×h. F1's y axis points up, screen y points down. */
  function makeProjection(bounds, w, h, pad = 36) {
    const bw = bounds.maxX - bounds.minX || 1;
    const bh = bounds.maxY - bounds.minY || 1;
    const scale = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    const ox = (w - bw * scale) / 2;
    const oy = (h - bh * scale) / 2;
    return (x, y) => [ox + (x - bounds.minX) * scale, h - (oy + (y - bounds.minY) * scale)];
  }

  /** Closed Path2D through the outline points. */
  function trackPath(outline, proj) {
    const path = new Path2D();
    outline.forEach((p, i) => {
      const [x, y] = proj(p.x, p.y);
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    });
    path.closePath();
    return path;
  }

  return { makeProjection, trackPath };
})();
