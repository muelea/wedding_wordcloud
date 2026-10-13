'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Device = require('../public/js/device');

test('mobile identity is independent of window size and desktop touch capability', () => {
  for (const navigator of [
    { userAgent: 'Macintosh Safari', maxTouchPoints: 0 },
    { userAgent: 'Windows Chrome', maxTouchPoints: 10, userAgentData: { mobile: false } },
    { userAgent: 'Linux Firefox', maxTouchPoints: 0 },
    {},
  ]) assert.equal(Device.isMobileDevice(navigator), false);
  for (const navigator of [
    { userAgent: 'iPhone Safari' }, { userAgent: 'iPad Safari' },
    { userAgent: 'Macintosh Safari', maxTouchPoints: 5 },
    { userAgent: 'Android Chrome', userAgentData: { mobile: false } },
    { userAgent: 'Reduced agent', userAgentData: { mobile: true } },
  ]) assert.equal(Device.isMobileDevice(navigator), true);
  assert.equal(Device.isIosDevice({ userAgent: 'Android Chrome' }), false);
  assert.equal(Device.isIosDevice({ userAgent: 'iPhone Safari' }), true);
});

test('the shared browser helper sets the CSS device flag before page interaction', () => {
  for (const [userAgent, expected] of [['Macintosh Safari', 'false'], ['Android Chrome', 'true']]) {
    const attributes = new Map();
    const window = { navigator: { userAgent }, document: { documentElement: {
      setAttribute: (name, value) => attributes.set(name, value),
    } } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/device'), 'utf8'), { window });
    assert.equal(attributes.get('data-ww-mobile-device'), expected);
    assert.equal(window.WolkenworteDevice.isMobileDevice(window.navigator), expected === 'true');
  }
});
