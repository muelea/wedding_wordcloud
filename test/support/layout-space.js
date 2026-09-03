'use strict';

// Exact edge sweep, deliberately independent of the runtime's raster scorer.
// Used only for small/medium regression fixtures, never the 500-word load tests.
function largestEmptyFraction(boxes, area) {
  const ys = [...new Set([area.y1, area.y2, ...boxes.flatMap(box => [box.y1, box.y2])])]
    .filter(y => y >= area.y1 && y <= area.y2).sort((a, b) => a - b);
  const ordered = boxes.slice().sort((a, b) => a.x1 - b.x1);
  let largest = 0;
  for (let top = 0; top < ys.length; top++) {
    for (let bottom = top + 1; bottom < ys.length; bottom++) {
      let right = area.x1;
      const height = ys[bottom] - ys[top];
      for (const box of ordered) {
        if (box.y1 >= ys[bottom] || box.y2 <= ys[top]) continue;
        largest = Math.max(largest, Math.max(0, Math.min(box.x1, area.x2) - right) * height);
        right = Math.max(right, Math.min(area.x2, box.x2));
      }
      largest = Math.max(largest, (area.x2 - right) * height);
    }
  }
  return largest / ((area.x2 - area.x1) * (area.y2 - area.y1));
}

function occupiedFraction(boxes, area) {
  return boxes.reduce((sum, box) => sum +
    Math.max(0, Math.min(box.x2, area.x2) - Math.max(box.x1, area.x1)) *
    Math.max(0, Math.min(box.y2, area.y2) - Math.max(box.y1, area.y1)), 0) /
    ((area.x2 - area.x1) * (area.y2 - area.y1));
}

function envelope(boxes) {
  return { x1: Math.min(...boxes.map(box => box.x1)), x2: Math.max(...boxes.map(box => box.x2)),
    y1: Math.min(...boxes.map(box => box.y1)), y2: Math.max(...boxes.map(box => box.y2)) };
}

module.exports = { largestEmptyFraction, occupiedFraction, envelope };
