// render/boreholePanel.js —— 钻孔面板（DOM 列表 + 复选 + section 按钮）
export function createBoreholePanel(el, { onToggle, onSection } = {}) {
  el.innerHTML = '<h3>钻孔</h3><div class="bh-list" style="display:flex;flex-direction:column;gap:2px"></div>';
  const list = el.querySelector('.bh-list');
  let data = []; // [{id, visible, layersCount}]

  const render = () => {
    list.innerHTML = '';
    if (!data.length) {
      const m = document.createElement('div'); m.style.cssText = 'color:#888;font-size:11px;padding:4px 0';
      m.textContent = '拖入 CSV 或加载源数据…'; list.appendChild(m); return;
    }
    for (const b of data) {
      const row = document.createElement('div'); row.className = 'bh-row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = b.visible;
      cb.addEventListener('change', () => onToggle && onToggle(b.id, cb.checked));
      const id = document.createElement('span'); id.className = 'bh-id'; id.textContent = b.id;
      const meta = document.createElement('span'); meta.style.cssText = 'color:#888;font-size:10px';
      meta.textContent = `${b.layersCount} 层`;
      const btn = document.createElement('button'); btn.className = 'bh-sec'; btn.textContent = '剖面';
      btn.addEventListener('click', () => onSection && onSection(b.id));
      row.append(cb, id, meta, btn);
      list.appendChild(row);
    }
  };
  return {
    setBoreholes(boreholes) {
      data = boreholes.map(b => ({ id: b.id, visible: true, layersCount: (b.layers || []).length }));
      render();
    },
  };
}
