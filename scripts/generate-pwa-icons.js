'use strict';

// Regenerate the tracked install icons after changing the existing brand mark.
// This is an asset-maintenance command, not a build/startup requirement.
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'public/assets/pwa');
const ICONS = [
  { filename: 'wolkenworte-192.png', size: 192, width: 0.86 },
  { filename: 'wolkenworte-512.png', size: 512, width: 0.86 },
  { filename: 'apple-touch-icon.png', size: 180, width: 0.86 },
  // The complete mark fits inside the central 80%-diameter safe circle.
  { filename: 'wolkenworte-maskable-512.png', size: 512, width: 0.58 },
];

async function main() {
  const logo = await loadImage(path.join(ROOT, 'public/z_icons/icon.svg'));
  fs.mkdirSync(OUTPUT, { recursive: true });
  for (const icon of ICONS) {
    const canvas = createCanvas(icon.size, icon.size);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fffdfa';
    context.fillRect(0, 0, icon.size, icon.size);
    const width = icon.size * icon.width;
    const height = width * logo.height / logo.width;
    context.drawImage(logo, (icon.size - width) / 2, (icon.size - height) / 2, width, height);
    fs.writeFileSync(path.join(OUTPUT, icon.filename), canvas.toBuffer('image/png'));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
