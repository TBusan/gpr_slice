// render/legendPanel.js —— 振幅色标图例（DOM Canvas + 节流同步）
export function createLegendPanel(el, style, { title = '振幅色标' } = {}) {
  el.classList.add('panel');
  el.innerHTML = `
    <h3>${title}</h3>
    <canvas width="200" height="12" style="display:block;width:200px;height:12px;background:#111;border-radius:2px"></canvas>
    <div class="legend-labels" style="display:flex;justify-content:space-between;font-size:11px;margin-top:2px">
      <span class="lo">--</span><span class="hi">--</span>
    </div>
  `;
  const cvs = el.querySelector('canvas');
  const ctx = cvs.getContext('2d');
  const loEl = el.querySelector('.lo'), hiEl = el.querySelector('.hi');
  let lastFp = '';
  const draw = () => {
    const fp = `${style.colorMapName}|${style.minValue}|${style.maxValue}`;
    if (fp === lastFp) return;
    lastFp = fp;
    const src = style.colorMap && style.colorMap.image;
    if (src) ctx.drawImage(src, 0, 0, 200, 12);
    loEl.textContent = style.minValue.toFixed(0);
    hiEl.textContent = style.maxValue.toFixed(0);
  };
  draw();
  return { update: draw };
}
