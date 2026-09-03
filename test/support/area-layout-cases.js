'use strict';

// Reconstructed from the reported mug layout; one contribution per word.
const SCREENSHOT_WORDS = ['ecsf', 'etwtw', 'faded', 'feef', 'gffgr', 'gtrht',
  'serer', 'srtdrt', 'srsrs', 'test', 'wrwer', 'dfgdfg', 'efffef'].sort().map(word => [word, 1]);
const AREA_CASES = [
  SCREENSHOT_WORDS,
  [['liebe', 1]],
  [['ja', 1], ['❤️', 1]],
  [['test', 1], ['👨‍👩‍👧‍👦', 1], ['👍🏽', 1], ['🇩🇪', 1]],
  [['zusammengehörigkeitsgefühl', 1], ['ja', 8], ['i', 1], ['WWW', 3]],
  Array.from({ length: 45 }, (_, index) => [
    ['liebe', 'glück', 'freundschaft', 'zusammen', 'tanzen', 'lachen'][index % 6] + index,
    1 + index * 7 % 20,
  ]),
];

module.exports = { SCREENSHOT_WORDS, AREA_CASES };
