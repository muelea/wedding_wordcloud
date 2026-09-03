'use strict';

// Reconstructed from the reported mug layout; one contribution per word.
const SCREENSHOT_WORDS = ['ecsf', 'etwtw', 'faded', 'feef', 'gffgr', 'gtrht',
  'serer', 'srtdrt', 'srsrs', 'test', 'wrwer', 'dfgdfg', 'efffef'].sort().map(word => [word, 1]);
// The September 3 report: short numbers, long words and three weighted emoji.
const REPORTED_WORDS = [['dg', 3], ['rtrt', 3], ['😊', 2], ['20', 2], ['efefe', 2],
  ['rg', 2], ['rgrgr', 2], ['rgrgrg', 2], ['rt', 2], ['sfsf', 2],
  ...['🍄‍🟫', '🦾', '1', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19',
    '2', '21', '22', '23', '24', '25', '26', '27', '28', '29', '3', '3r3r3', '4',
    '4r4et', '4r4r4', '5', '6', '7', '8', '9', 'adada', 'dede', 'dfdf', 'dfg',
    'eded', 'eef', 'ef', 'efweew', 'ergregre', 'fefe', 'fgfd', 'frfrsf', 'gdgdfg',
    'ggg', 'gr', 'grgr', 'grgrg', 'hhh', 'hhsjd', 'hth', 'jdjd', 'liebe', 'rfrfr',
    'rfrg', 'rgrg', 'rtr', 'sdfdsf', 'se', 'sfsfs', 'yr'].map(word => [word, 1])];
const EMOJI_WORDS = ['liebe', 'glück', 'familie', 'zusammen', '😊', '🌷', '🎉', '💖']
  .map(word => [word, 1]);
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

module.exports = { SCREENSHOT_WORDS, REPORTED_WORDS, EMOJI_WORDS, AREA_CASES };
