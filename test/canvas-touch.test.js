'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CanvasTouch } = require('../public/js/canvas-touch');

function setup(navigation = false) {
  const object = { x: 100, y: 100, angle: 0, scaleX: 1, scaleY: 1 };
  let commits = 0, selections = 0, viewWrites = 0;
  const touch = new CanvasTouch({
    navigation: () => navigation,
    hit: p => p.x >= 80 && p.x <= 120 && p.y >= 80 && p.y <= 120 ? object : null,
    select: () => selections++, toScene: point => point,
    readObject: () => ({ ...object }), writeObject: (_, state) => Object.assign(object, state),
    readView: () => ({ zoom: 1 }), writeView: () => viewWrites++, commit: () => commits++,
  });
  return { touch, object, count: () => ({ commits, selections, viewWrites }) };
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
    const { touch, object, count } = setup(navigation);
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
