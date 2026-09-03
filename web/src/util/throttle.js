// util/throttle.js —— 节流（trailing）+ 防抖（标准实现，wait ms）
export function throttle(fn, wait, { leading = true, trailing = true } = {}) {
  let last = 0, timer = null, lastArgs = null;
  return function (...args) {
    const now = Date.now();
    lastArgs = args;
    if (leading && now - last >= wait) { last = now; fn.apply(this, args); lastArgs = null; }
    if (timer == null) {
      timer = setTimeout(() => {
        if (trailing && lastArgs) fn.apply(this, lastArgs);
        last = Date.now(); timer = null; lastArgs = null;
      }, Math.max(0, wait - (now - last)));
    }
  };
}

export function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
  };
}
