// dataset/sources.js —— 加载数据源列表 + 解析 ?src= + URL 切换
const URL_KEY = 'src';

export async function loadSources(url = '/sources.json') {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`sources.json ${r.status}`);
  const data = await r.json();
  if (!data.sources || !Array.isArray(data.sources)) throw new Error('sources.json 格式错');
  return data;
}

export function getSourceFromUrl() {
  const p = new URLSearchParams(location.search);
  return p.get(URL_KEY);
}

export function switchSource(srcId) {
  const url = new URL(location.href);
  if (srcId) url.searchParams.set(URL_KEY, srcId);
  else url.searchParams.delete(URL_KEY);
  // 完整重载避免 teardown 泄漏
  location.replace(url.toString());
}
