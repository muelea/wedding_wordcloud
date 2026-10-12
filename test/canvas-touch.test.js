'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CanvasTouch } = require('../public/js/canvas-touch');

function setup(navigation = false, selected = true) {
  const object = { x: 100, y: 100, angle: 0, scaleX: 1, scaleY: 1 };
  let commits = 0, selections = 0, viewWrites = 0;
  let active = selected ? object : null;
  const contains = (_, p) => p.x >= object.x - 20 && p.x <= object.x + 20 && p.y >= object.y - 20 && p.y <= object.y + 20;
  const touch = new CanvasTouch({
    navigation: () => navigation,
    selected: () => active, contains,
    hit: p => p.x >= 80 && p.x <= 120 && p.y >= 80 && p.y <= 120 ? object : null,
    select: target => { active = target; selections++; }, deselect: () => { active = null; }, toScene: point => point,
    readObject: () => ({ ...object }), writeObject: (_, state) => Object.assign(object, state),
    readView: () => ({ zoom: 1 }), writeView: () => viewWrites++, commit: () => commits++,
  });
  return { touch, object, selected: () => active, count: () => ({ commits, selections, viewWrites }) };
}

test('one finger moves an element without resizing or rotating it', () => {
  const { touch, object, count } = setup();
  touch.down(1, { x: 100, y: 100 });
  touch.move(1, { x: 130, y: 120 });
  assert.deepEqual(object, { x: 130, y: 120, angle: 0, scaleX: 1, scaleY: 1 });
  assert.equal(count().commits, 0);
  touch.up(1);
  assert.equal(count().commits, 1);
});

test('a stationary first finger anchors simultaneous resize and rotation', () => {
  const { touch, object, count } = setup();
  touch.down(1, { x: 100, y: 100 });
  touch.down(2, { x: 200, y: 100 }); // Second finger need not fit on the object.
  touch.move(2, { x: 100, y: 300 });
  assert.equal(object.scaleX, 2);
  assert.equal(object.scaleY, 2);
  assert.equal(object.angle, 90);
  assert.equal(object.x, 100);
  assert.equal(object.y, 100);
  assert.equal(count().viewWrites, 0);
  touch.up(2); touch.up(1);
  assert.equal(count().commits, 1);
});

test('adding and removing a finger rebases at the current position with one Undo commit', () => {
  const { touch, object, count } = setup();
  touch.down(1, { x: 100, y: 100 });
  touch.move(1, { x: 130, y: 100 });
  touch.down(2, { x: 230, y: 100 });
  assert.equal(object.x, 130, 'the second contact does not jump the object');
  touch.move(2, { x: 330, y: 100 });
  touch.up(1);
  touch.move(2, { x: 340, y: 110 });
  touch.up(2);
  assert.equal(object.x, 140);
  assert.equal(object.y, 110);
  assert.equal(object.scaleX, 2);
  assert.equal(count().commits, 1);
  touch.finish();
  assert.equal(count().commits, 1, 'cancellation/capture loss cannot commit twice');
});

test('background gestures and navigation mode never transform a selected element', () => {
  for (const navigation of [false, true]) {
    const { touch, object, count } = setup(navigation, false);
    touch.down(1, { x: navigation ? 100 : 20, y: 100 });
    touch.down(2, { x: 200, y: 100 });
    touch.move(2, { x: 300, y: 130 });
    touch.up(1); touch.up(2);
    assert.deepEqual(object, { x: 100, y: 100, angle: 0, scaleX: 1, scaleY: 1 });
    assert.equal(count().commits, 0);
    assert.equal(count().selections, 0);
    assert.equal(count().viewWrites, 1);
  }
});

test('selection requires a tap; a pinch starting on a word navigates without selecting it', () => {
  const { touch, object, selected, count } = setup(false, false);
  touch.down(1, { x: 100, y: 100 });
  assert.equal(selected(), null, 'pointerdown alone never activates an element');
  touch.down(2, { x: 200, y: 100 });
  touch.move(2, { x: 300, y: 100 });
  touch.up(2); touch.up(1);
  assert.equal(selected(), null);
  assert.equal(count().commits, 0);
  assert.equal(count().viewWrites, 1);
  touch.down(1, { x: 100, y: 100 }); touch.up(1);
  assert.equal(selected(), object);
  assert.equal(count().selections, 1);
  assert.equal(count().commits, 0);
});

test('locked selection transforms from background contacts and persists between gestures', () => {
  const { touch, object, selected, count } = setup();
  touch.down(1, { x: 300, y: 300 });
  touch.move(1, { x: 310, y: 315 }); touch.up(1);
  assert.equal(object.x, 110); assert.equal(object.y, 115);
  touch.down(1, { x: 400, y: 400 }); touch.down(2, { x: 500, y: 400 });
  touch.move(2, { x: 400, y: 600 }); touch.up(2); touch.up(1);
  assert.equal(object.scaleX, 2); assert.equal(object.angle, 90);
  assert.equal(object.x, 110); assert.equal(object.y, 115, 'off-object pinches keep the object centre');
  assert.equal(selected(), object);
  assert.equal(count().commits, 2);
  assert.equal(count().selections, 0);
  assert.equal(count().viewWrites, 0);
});

test('only a tap on the selected item deselects; background taps and cancelled contacts keep the lock', () => {
  const { touch, object, selected } = setup();
  touch.down(1, { x: 300, y: 300 }); touch.up(1);
  assert.equal(selected(), object);
  touch.down(1, { x: 100, y: 100 }); touch.up(1, { cancelled: true });
  assert.equal(selected(), object);
  touch.down(1, { x: 100, y: 100 }); touch.finish();
  assert.equal(selected(), object, 'viewport changes and lost contacts are not taps');
  touch.down(1, { x: 100, y: 100 }); touch.up(1);
  assert.equal(selected(), null);
});

test('taps, slight finger jitter and third contacts do not edit the design', () => {
  const { touch, object, count } = setup();
  touch.down(1, { x: 100, y: 100 });
  touch.move(1, { x: 102, y: 101 });
  touch.down(2, { x: 200, y: 100 });
  touch.down(3, { x: 300, y: 100 });
  touch.move(3, { x: 800, y: 100 });
  touch.up(3); touch.up(2); touch.up(1);
  assert.deepEqual(object, { x: 100, y: 100, angle: 0, scaleX: 1, scaleY: 1 });
  assert.equal(count().commits, 0);
});
