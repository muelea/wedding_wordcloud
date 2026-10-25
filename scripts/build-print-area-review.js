'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const ROOT = path.join(__dirname, '../reports/print-area-audit-2026-10-24/full');
const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f)));
// Normalize transparent/background padding only; artwork and product retain
// their proportions. These are contact sheets, not difference-score approval.
async function trimmed(file) {
  const image = await loadImage(path.join(ROOT, file));
  const c = createCanvas(image.width, image.height), x = c.getContext('2d'); x.drawImage(image, 0, 0);
  const data = x.getImageData(0, 0, c.width, c.height).data;
  const bg = Array.from(data.slice(0, 4));
  let left = c.width, right = 0, top = c.height, bottom = 0;
  for (let y = 0; y < c.height; y++) for (let z = 0; z < c.width; z++) {
    const i = (y * c.width + z) * 4;
    const visible = bg[3] < 10 ? data[i + 3] > 20 : data[i + 3] > 20 &&
      Math.max(...[0, 1, 2].map(k => Math.abs(data[i + k] - bg[k]))) > 18;
    if (visible) { left = Math.min(left, z); right = Math.max(right, z); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  return { image, left: Math.max(0, left - 6), top: Math.max(0, top - 6), width: Math.min(c.width, right + 7) - Math.max(0, left - 6), height: Math.min(c.height, bottom + 7) - Math.max(0, top - 6) };
}
async function main() {
  const plan = read('coverage.json'), renders = read('local-renders.json');
  const only = process.argv.find(a => a.startsWith('--only='))?.slice(7);
  const cases = plan.cases.filter(c => c.providerStatus === 'completed' && (!only || c.id.includes(only)));
  fs.mkdirSync(path.join(ROOT, 'review-pages'), { recursive: true });
  const pages = [];
  for (let start = 0; start < cases.length; start += 4) {
    const batch = cases.slice(start, start + 4), canvas = createCanvas(1200, batch.length * 330);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const [row, c] of batch.entries()) {
      ctx.fillStyle = '#121212'; ctx.font = 'bold 19px sans-serif'; ctx.fillText(c.id, 15, row * 330 + 24);
      // Curved side views allow matching the provider camera without changing
      // the underlying print mapping. Both sides stay in the archived renders.
      const local = renders.cases[c.id].views;
      const refs = [{ label: 'Local front', file: local.front.file }];
      if (local.left) refs.push({ label: 'Local side', file: local.left.file });
      if (local.back && !local.left) refs.push({ label: 'Local back', file: local.back.file });
      refs.push(...c.provider.slice(0, 4).map(v => ({ label: 'Printful ' + (v.view || v.placement || ''), file: v.file })));
      const width = 1200 / refs.length;
      for (const [column, v] of refs.entries()) {
        const t = await trimmed(v.file), scale = Math.min((width - 20) / t.width, 265 / t.height);
        ctx.drawImage(t.image, t.left, t.top, t.width, t.height,
          column * width + (width - t.width * scale) / 2, row * 330 + 37 + (265 - t.height * scale) / 2, t.width * scale, t.height * scale);
        ctx.fillStyle = '#303030'; ctx.font = '14px sans-serif'; ctx.fillText(v.label, column * width + 15, row * 330 + 321);
      }
    }
    const file = `review-pages/${only || 'all'}-${Math.floor(start / 4) + 1}.png`;
    fs.writeFileSync(path.join(ROOT, file), canvas.toBuffer('image/png'));
    pages.push({ file, cases: batch.map(c => c.id) }); canvas.width = 1;
  }
  fs.writeFileSync(path.join(ROOT, 'review-pages', `${only || 'all'}-index.json`), JSON.stringify(pages, null, 2) + '\n');
  if (!only) {
    const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const rows = cases.map(c => {
      const images = [
        ...Object.entries(renders.cases[c.id].views).map(([view, v]) => ({ ...v, label: `Wolkenworte ${view}` })),
        ...c.provider.map(v => ({ ...v, label: `Printful ${v.view || v.placement || ''}` })),
      ].map(v => `<figure><a href="${escape(v.file)}"><img loading="lazy" src="${escape(v.file)}" alt="${escape(v.label)}"></a><figcaption>${escape(v.label)}</figcaption></figure>`).join('');
      return `<article id="${escape(c.id)}" data-search="${escape(c.id)}"><h2>${escape(c.id)}</h2><p>Variante ${c.variantId} · ${c.product.printFile.width} × ${c.product.printFile.height} px · ${escape(c.printAreaResult || 'review pending')}</p><section>${images}</section><p>${escape(c.reviewNotes || '')}</p></article>`;
    }).join('');
    fs.writeFileSync(path.join(ROOT, 'index.html'), `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Druckflächen · vollständiger Vergleich</title><style>body{font:15px system-ui;margin:24px;color:#20202a}header{max-width:1000px}input{padding:10px;min-width:320px}article{border-bottom:1px solid #ccc;padding:20px 0}h2{font-size:18px}section{display:flex;flex-wrap:wrap}figure{margin:8px;width:230px}img{width:230px;height:250px;object-fit:contain;background:#fff}figcaption{text-align:center;font-size:13px}article[hidden]{display:none}</style></head><body><header><h1>Druckflächen: 67 Varianten · 78 Ausrichtungen · 84 Seiten</h1><p>106 originale Printful-Prüfbilder, verglichen mit dem echten lokalen Renderer. Alle Größen, Farben und Druckseiten sind enthalten. Kalibriermuster statt Kundendaten.</p><p>Technische Ansichten ohne Kameraneigung. Formen, Falten und Farben der eigenen Modelle bleiben Annäherungen. Kein Freigabenachweis für physische Fertigungstoleranzen oder Farben.</p><label>Produkt filtern <input id="filter" type="search" placeholder="z. B. sleeve, 21474, landscape"></label><p><a href="README.md">Prüfbericht und Änderungen</a> · <a href="coverage.json">Vollständige Prüfdaten</a></p></header>${rows}<script>document.getElementById('filter').addEventListener('input',event=>{const query=event.target.value.toLowerCase();for(const row of document.querySelectorAll('article'))row.hidden=!row.dataset.search.includes(query)});</script></body></html>`);
  }
  console.log(`${cases.length} cases on ${pages.length} pages`);
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
