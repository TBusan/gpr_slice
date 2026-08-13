// lod/limiter.js —— 信号量：限制同时进行的异步操作数（多线共享的瓦片加载并发预算）
//
// 浏览器对同域 HTTP 连接有 ~6 条上限；12 线各自 6 并发 = 72 个在途请求排队等 6 条连接，
// 缩放 LOD 后新 desired 瓦片要等全部过期请求走完才轮到。全局共享一个 limiter 把在途压到 ~9，
// 配合 drainQueue 的 desired 过滤，过期请求不再占连接，新瓦片更快拿到连接。
export function createLimiter(max) {
  let active = 0;
  const waiters = [];
  return {
    get active() { return active; },
    acquire() {
      return new Promise((res) => {
        if (active < max) { active++; res(); }
        else waiters.push(res);
      });
    },
    release() {
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      if (next) { active++; next(); }
    },
  };
}
