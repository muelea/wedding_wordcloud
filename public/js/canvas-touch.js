(function (root) {
  'use strict';

  const midpoint = points => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
  const distance = points => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  const angle = points => Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
  function transformPair(before, after) {
    return { start: midpoint(before), end: midpoint(after),
      scale: distance(after) / Math.max(8, distance(before)),
      rotation: Math.atan2(Math.sin(angle(after) - angle(before)), Math.cos(angle(after) - angle(before))) };
  }

  // Only an explicit tap changes selection. A selected element owns subsequent
  // gestures anywhere on the canvas until it is explicitly deselected.
  class CanvasTouch {
    constructor(adapter) { this.adapter = adapter; this.points = new Map(); this.gesture = null; }

    down(id, point) {
      if (this.points.has(id) || this.points.size >= 2) return;
      if (this.tapTimer && this.lastTap && !this.adapter.contains(this.lastTap.object, point)) {
        const target = this.lastTap.object;
        this.cancelTap();
        if (this.adapter.selected() === target) this.adapter.deselect();
      }
      clearTimeout(this.tapTimer);
      this.tapTimer = null;
      this.points.set(id, point);
      if (!this.gesture) {
        const navigation = this.adapter.navigation();
        const target = navigation ? null : this.adapter.selected();
        this.gesture = { target, candidate: navigation || target ? null : this.adapter.hit(point),
          onSelected: target && this.adapter.contains(target, point), navigation,
          changed: false, moved: false, multiple: false };
      }
      if (this.points.size > 1) this.gesture.multiple = true;
      this.rebase();
    }

    rebase() {
      const gesture = this.gesture;
      if (!gesture || !this.points.size) return;
      gesture.screen = [...this.points.values()].map(point => ({ ...point }));
      if (gesture.target) {
        gesture.scene = gesture.screen.map(point => this.adapter.toScene(point));
        gesture.object = this.adapter.readObject(gesture.target);
      } else gesture.view = this.adapter.readView();
    }

    move(id, point) {
      if (!this.points.has(id) || !this.gesture) return;
      this.points.set(id, point);
      const gesture = this.gesture, points = [...this.points.values()];
      if (points.length !== gesture.screen.length) return;
      if (Math.max(...points.map((p, i) => Math.hypot(p.x - gesture.screen[i].x, p.y - gesture.screen[i].y))) < 5) return;
      gesture.moved = true;
      this.cancelTap();
      if (gesture.target) {
        const scene = points.map(p => this.adapter.toScene(p));
        const original = gesture.object;
        let next;
        if (points.length === 1) {
          next = { ...original, x: original.x + scene[0].x - gesture.scene[0].x,
            y: original.y + scene[0].y - gesture.scene[0].y };
        } else {
          const pair = transformPair(gesture.scene, scene);
          const scale = Math.max(original.minimumScale || .01, Math.min(20, pair.scale));
          const rotation = Math.abs(pair.rotation) < Math.PI / 60 ? 0 : pair.rotation;
          const degrees = original.angle + rotation * 180 / Math.PI;
          const snapped = Math.round(degrees / 90) * 90;
          // Resize/twist around the element's centre. Off-element contacts must
          // not swing the element around a distant finger pivot.
          next = { ...original,
            scaleX: original.scaleX * scale, scaleY: original.scaleY * scale,
            angle: Math.abs(degrees - snapped) < 2 ? snapped : degrees };
        }
        this.adapter.writeObject(gesture.target, next);
        gesture.changed = true;
      } else {
        const pair = points.length === 2 ? transformPair(gesture.screen, points) : {
          start: gesture.screen[0], end: points[0], scale: 1,
        };
        this.adapter.writeView(gesture.view, pair);
      }
    }

    up(id, { cancelled = false } = {}) {
      if (!this.points.delete(id)) return;
      if (cancelled) this.gesture.moved = true;
      if (this.points.size) this.rebase();
      else {
        const gesture = this.gesture;
        const tapped = !gesture.navigation && !gesture.moved && !gesture.multiple;
        this.finish({ preserveTap: tapped });
        if (tapped) this.tap(gesture);
      }
    }

    tap(gesture) {
      const object = gesture.target ? (gesture.onSelected ? gesture.target : null) : gesture.candidate;
      const point = gesture.screen[0], now = Date.now();
      const editable = object && this.adapter.canDoubleTap?.(object);
      if (editable && this.lastTap?.object === object && now - this.lastTap.time < 300 &&
          Math.hypot(point.x - this.lastTap.point.x, point.y - this.lastTap.point.y) < 24) {
        this.cancelTap();
        this.adapter.doubleTap(object);
        return;
      }
      this.cancelTap();
      if (!object) return;
      if (!gesture.target) this.adapter.select(object);
      else if (editable) {
        // Keep the lock through the first tap of a double tap. A single tap
        // still unlocks, after the short recognition window.
        this.tapTimer = setTimeout(() => {
          if (this.adapter.selected() === object) this.adapter.deselect();
          this.cancelTap();
        }, 300);
      } else this.adapter.deselect();
      if (editable) this.lastTap = { object, point, time: now };
    }

    cancelTap() {
      clearTimeout(this.tapTimer);
      this.tapTimer = null;
      this.lastTap = null;
    }

    finish({ preserveTap = false } = {}) {
      if (!preserveTap) this.cancelTap();
      const gesture = this.gesture;
      this.gesture = null;
      this.points.clear();
      if (gesture?.target && gesture.changed) this.adapter.commit(gesture.target);
    }
  }

  root.CanvasTouch = CanvasTouch;
  if (typeof module === 'object' && module.exports) module.exports = { CanvasTouch, transformPair };
})(typeof window === 'object' ? window : globalThis);
