'use strict';

// Deterministic, nonlinear metrics make full-search reference hashes portable
// across Canvas/FreeType versions. Separate tests exercise the actual fonts.
function context() {
  return {
    font: '400 12px serif',
    measureText(text) {
      const size = Number(this.font.match(/([\d.]+)px/)[1]);
      const weight = this.font.startsWith('700') ? 1.06 : 1;
      const advance = Array.from(text).reduce((sum, char) => sum +
        ('il .'.includes(char) ? .22 : 'WM'.includes(char) ? 1.08 : .57), 0);
      const width = Math.round(advance * size * weight * 64) / 64;
      return { width, actualBoundingBoxLeft: size * .02, actualBoundingBoxRight: width - size * .01,
        actualBoundingBoxAscent: size * .72, actualBoundingBoxDescent: size * .16 };
    },
  };
}

function cases() {
  return [5, 17, 40].flatMap(count => [[36, 36, 2628, 978], [201, 170, 1416, 2273]]
    .map(([x, y, width, height]) => ({ count, slots: [{ x, y, width, height, optimize: true }],
      design: Array.from({ length: count }, (_, index) => ({
        id: `word-${index}`, x: 500, y: 500,
        ...(index === 13 ? { type: 'image', width: 83.25, height: 146.75 }
          : index === 21 ? { type: 'icon', icon: 'heart', size: 81.5 }
            : { text: ['Liebe', 'Gemeinsam alt werden', 'Glück', '❤️', 'WWW', 'i', '🌉', '🧑‍🌾 zusammen'][index % 8],
              fontSize: 130 - index * 1.2, angle: index % 13 === 0 ? 23 : 0,
              fontFamily: ['classic', 'lora', 'montserrat', 'caveat', 'baloo-2'][index % 5],
              fontWeight: index % 2 ? 700 : 400, fontStyle: index % 3 ? 'normal' : 'italic',
              underline: index % 4 === 0, linethrough: index % 5 === 0 }),
        color: '#123456',
      })),
    })));
}

module.exports = { context, cases };
