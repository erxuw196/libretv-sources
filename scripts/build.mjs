/**
 * LibreTV 源清单自动构建：
 *  1) 点播：拉取两个 Apple CMS 列表（lubin776 / 0.12yue），只保留 JSON 接口，按域名去重，
 *     逐个用 ?ac=videolist&wd=庆余年 实测，通过的才保留（上限 100）。
 *  2) 直播：固定保留人工筛选的特色源；再拉取 livelist 里的 M3U 订阅，解析成频道并跨源去重，
 *     汇总成本仓库内 live/merged.m3u（LibreTV 订阅这个固定 raw 地址即可，每天自动更新）。
 *  3) 输出标准 LibreTV-SourceList JSON：libretv-sources.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36';
const WD = '庆余年';

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config/inputs.json'), 'utf8'));
const limits = cfg.limits ?? {};

async function fetchText(url, timeout = 15000, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function pool(items, worker, concurrency = 12) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { ok: false, reason: err?.message ?? String(err) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** 解析 cjlist 行：名称|别名|type: N|api: URL */
function parseCjList(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^|]+?)\s*\|\s*([^|]*)\s*\|\s*type:\s*(\d+)\s*\|\s*api:\s*(\S+)\s*$/);
    if (!m) continue;
    if (m[3] !== '1') continue; // 只保留 JSON 接口，跳过 0=XML
    const url = m[4].trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/i.test(url)) continue; // 跳过 csp_Bili 之类非 URL
    out.push({ name: m[1].trim(), url });
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function pathKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

/** 解析 M3U 频道（#EXTINF 下一行是地址） */
function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF')) continue;
    const name = line.slice(line.lastIndexOf(',') + 1).trim() || '未命名';
    const group = (line.match(/group-title="([^"]*)"/)?.[1] ?? '').trim();
    const logo = line.match(/tvg-logo="([^"]*)"/)?.[1] ?? '';
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
    const url = lines[j]?.trim();
    if (!url || !/^(https?|rtmp|rtsp):\/\//i.test(url)) continue;
    channels.push({ name, url, group, logo });
    i = j;
  }
  return channels;
}

/** 点播源实测：搜索「庆余年」，要求 code=1、list 非空且至少一条带 vod_play_url */
async function testVod(source) {
  const sep = source.url.includes('?') ? '&' : '?';
  const target = `${source.url}${sep}ac=videolist&wd=${encodeURIComponent(WD)}`;
  const text = await fetchText(target, 12000);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: '非 JSON 响应' };
  }
  if (json?.code !== 1) return { ok: false, reason: `code=${json?.code}` };
  if (!Array.isArray(json.list) || json.list.length === 0) return { ok: false, reason: '搜索无结果' };
  if (!json.list.some((it) => it && typeof it.vod_play_url === 'string' && it.vod_play_url)) {
    return { ok: false, reason: '缺 vod_play_url' };
  }
  return { ok: true, hits: json.list.length };
}

// ---------- 点播 ----------
const vodCandidates = [];
const seenVod = new Set();
for (const seed of cfg.vodSeed ?? []) {
  const key = pathKey(seed.url);
  if (seenVod.has(key)) continue;
  seenVod.add(key);
  vodCandidates.push({ name: seed.name, url: seed.url, curated: true });
}
for (const listUrl of cfg.vodUpstreams ?? []) {
  try {
    const parsed = parseCjList(await fetchText(listUrl, 20000));
    for (const item of parsed) {
      const key = pathKey(item.url);
      if (seenVod.has(key)) continue;
      seenVod.add(key);
      vodCandidates.push({ ...item, curated: false, from: hostOf(listUrl) });
    }
  } catch (err) {
    console.warn(`[warn] 点播上游拉取失败 ${listUrl}: ${err.message}`);
  }
}

console.log(`点播候选 ${vodCandidates.length} 个，开始实测…`);
const vodTested = await pool(vodCandidates, async (s) => ({ ...s, ...(await testVod(s)) }), 12);
const vodFinal = vodTested
  .filter((s) => s.ok)
  .sort((a, b) => (b.curated === true) - (a.curated === true) || (b.hits ?? 0) - (a.hits ?? 0))
  .slice(0, limits.vod ?? 100)
  .map((s) => ({ name: s.name, url: s.url }));
console.log(`点播可用 ${vodTested.filter((s) => s.ok).length} 个，保留 ${vodFinal.length} 个`);

// ---------- 直播 ----------
const merged = [];
const seenLive = new Set();
const nameCount = new Map();
function addChannel(ch) {
  if (seenLive.has(ch.url)) return;
  const n = nameCount.get(ch.name) ?? 0;
  if (n >= 2) return; // 同名频道最多保留 2 个不同地址，避免重复源把列表撑大
  seenLive.add(ch.url);
  nameCount.set(ch.name, n + 1);
  merged.push(ch);
}
for (const cur of cfg.liveCurated ?? []) {
  try {
    for (const ch of parseM3u(await fetchText(cur.url, 20000))) addChannel(ch);
  } catch (err) {
    console.warn(`[warn] 特色直播源拉取失败 ${cur.name}: ${err.message}`);
  }
}
const liveListUrls = [];
for (const listUrl of cfg.liveUpstreams ?? []) {
  try {
    const text = await fetchText(listUrl, 25000);
    for (const p of text.split(/\r?\n/).map((l) => l.split('|').map((x) => x.trim()))) {
      if (p.length >= 4 && /^https?:\/\//i.test(p[3])) liveListUrls.push(p[3]);
    }
  } catch (err) {
    console.warn(`[warn] 直播上游拉取失败 ${listUrl}: ${err.message}`);
  }
}
console.log(`直播订阅列表 ${liveListUrls.length} 个，开始解析…`);
const fetchedLists = await pool(
  liveListUrls,
  async (u) => {
    try {
      return { u, text: await fetchText(u, 12000, 0) };
    } catch (err) {
      return { u, reason: err?.message ?? String(err) };
    }
  },
  8,
);
for (const r of fetchedLists) {
  if (!r || !r.text) {
    console.warn(`[warn] 订阅拉取失败 ${r?.u ?? '?'}: ${r?.reason ?? 'unknown'}`);
    continue;
  }
  for (const ch of parseM3u(r.text)) addChannel(ch);
}
const mergedCapped = merged.slice(0, limits.mergedChannels ?? 3000);
console.log(`直播频道去重后 ${merged.length} 个，写入 ${mergedCapped.length} 个`);

const m3uLines = ['#EXTM3U', `#PLAYLIST:LibreTV 聚合直播（${new Date().toISOString().slice(0, 10)}）`];
for (const ch of mergedCapped) {
  const attrs = [ch.group ? `group-title="${ch.group.replace(/"/g, "'")}"` : '', ch.logo ? `tvg-logo="${ch.logo.replace(/"/g, "'")}"` : '']
    .filter(Boolean)
    .join(' ');
  m3uLines.push(attrs ? `#EXTINF:-1 ${attrs},${ch.name}` : `#EXTINF:-1,${ch.name}`);
  m3uLines.push(ch.url);
}
await fs.mkdir(path.join(ROOT, 'live'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'live/merged.m3u'), m3uLines.join('\n') + '\n', 'utf8');

// ---------- 汇总 ----------
const repo = process.env.GITHUB_REPOSITORY ?? 'erxuw196/libretv-sources';
const branch = process.env.GITHUB_REF_NAME ?? 'main';
const mergedRaw = `https://raw.githubusercontent.com/${repo}/${branch}/live/merged.m3u`;

const liveSources = [
  { name: '聚合直播（每日自动更新）', url: mergedRaw, epg: 'http://epg.51zmt.top:8000/e.xml.gz' },
  ...(cfg.liveCurated ?? []).map((s) => (s.epg ? { name: s.name, url: s.url, epg: s.epg } : { name: s.name, url: s.url })),
].slice(0, limits.live ?? 50);

const payload = {
  name: 'LibreTV 源清单（自建自动更新）',
  version: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
  exportedAt: new Date().toISOString().slice(0, 10),
  sources: vodFinal,
  liveSources,
};
await fs.writeFile(path.join(ROOT, 'libretv-sources.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`完成：点播 ${payload.sources.length} 个 / 直播源 ${payload.liveSources.length} 个（聚合频道 ${mergedCapped.length}）`);
