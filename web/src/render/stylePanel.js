// render/stylePanel.js —— 动态样式面板，只更新 style 对象（uniform 每帧同步）
//
// 管线（规格书 §33）：raw → scale/offset(在 tileLoader) → gain → normalize → gamma
//   → threshold → colorMap → opacity → ray 累积。这里不重拉任何瓦片。

const COLORMAPS = ['blue-red', 'seismic', 'grayscale', 'jet'];

function sliderRow(label, key, min, max, step, fmt) {
  const row = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = '1';
  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = fmt(1);
  row.append(span, input, val);
  return { row, input, val, fmt };
}

export function createStylePanel(container, style, meta) {
  const h = document.createElement('h3');
  h.textContent = '动态样式';
  container.appendChild(h);

  // 色带
  const cmLabel = document.createElement('label');
  const cmSpan = document.createElement('span');
  cmSpan.textContent = '色带';
  const cmSelect = document.createElement('select');
  for (const name of COLORMAPS) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    cmSelect.appendChild(opt);
  }
  cmSelect.value = style.colorMapName;
  cmSelect.addEventListener('change', () => style.setColorMap(cmSelect.value));
  cmLabel.append(cmSpan, cmSelect);
  container.appendChild(cmLabel);

  // 窗宽
  const { globalMin, globalMax } = meta.value;
  const range = globalMax - globalMin;
  const lo = globalMin + range * 0.3;
  const hi = globalMax - range * 0.3;

  // 控件引用挂到 style 上，供 autoFitWindow() 等外部更新后同步显示
  style._inputs = style._inputs || {};

  const makeNumber = (label, key, def) => {
    const row = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.style.width = '76px';
    input.value = String(def);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) style[key] = v;
    });
    row.append(span, input);
    container.appendChild(row);
    style._inputs[key] = input;
    return input;
  };

  makeNumber('min', 'minValue', lo);
  makeNumber('max', 'maxValue', hi);

  // 增益 / gamma / 阈值 / 不透明度
  const mkSlider = (label, key, min, max, step, fmt = v => v.toFixed(2)) => {
    const { row, input, val } = sliderRow(label, key, min, max, step, fmt);
    input.value = String(style[key]);
    val.textContent = fmt(style[key]);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      style[key] = v;
      val.textContent = fmt(v);
    });
    container.appendChild(row);
    style._inputs[key] = input;
  };

  style.thresholdMin = globalMin;
  style.thresholdMax = globalMax;
  style.gain = 1;
  style.gamma = 1;
  style.opacity = 0.6;
}
