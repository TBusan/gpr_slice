// render/layerPanel.js —— 图层面板 UI（DOM 列表 + 删除/可见性 + 文件拖入入口）
const COLORS = ['#4d9fff', '#4caf50', '#ffb74d', '#e57373', '#ba68c8', '#4dd0e1', '#ff8a65'];

export function createLayerPanel(el, lm, { onDrop, onToggleBuiltin } = {}) {
  const listEl = document.createElement('div');
  el.appendChild(listEl);

  const render = (layers) => {
    listEl.innerHTML = '';
    const h = document.createElement('h3'); h.textContent = '图层'; listEl.appendChild(h);
    layers.forEach((l, i) => {
      const row = document.createElement('div'); row.className = 'row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = l.visible;
      cb.addEventListener('change', () => { onToggleBuiltin ? onToggleBuiltin(l, cb.checked) : lm.setVisible(l.id, cb.checked); });
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = COLORS[i % COLORS.length];
      const lab = document.createElement('span'); lab.className = 'label'; lab.textContent = l.label;
      row.append(cb, sw, lab);
      if (!l.builtin) {
        const del = document.createElement('button'); del.className = 'del'; del.textContent = '×';
        del.addEventListener('click', () => lm.remove(l.id));
        row.appendChild(del);
      }
      listEl.appendChild(row);
    });
  };
  render(lm.list());
  lm.onChange(render);

  return { render };
}
