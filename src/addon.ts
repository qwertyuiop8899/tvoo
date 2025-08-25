// TypeScript may not have types for stremio-addon-sdk in this workspace; use minimal typing.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { addonBuilder, Manifest, Stream, getRouter } from 'stremio-addon-sdk';
/// <reference types="node" />
import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';

// Minimal config: countries supported and mapping to Vavoo group filters
const SUPPORTED_COUNTRIES = [
  { id: 'it', name: 'Italia', group: 'Italy' },
  { id: 'uk', name: 'United Kingdom', group: 'United Kingdom' },
  { id: 'fr', name: 'France', group: 'France' },
  { id: 'de', name: 'Germany', group: 'Germany' },
  { id: 'pt', name: 'Portugal', group: 'Portugal' },
  { id: 'es', name: 'Spain', group: 'Spain' },
  { id: 'al', name: 'Albania', group: 'Albania' },
  { id: 'tr', name: 'Turkey', group: 'Turkey' },
  { id: 'nl', name: 'Nederland', group: 'Nederland' },
  { id: 'ar', name: 'Arabia', group: 'Arabia' },
  { id: 'bk', name: 'Balkans', group: 'Balkans' },
];

const DEFAULT_VAVOO_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

function vdbg(...args: any[]) { if (process.env.VAVOO_DEBUG !== '0') { try { console.log('[VAVOO]', ...args); } catch {} } }

// Simple on-disk cache for daily catalogs (persist across restarts while container is alive)
type CatalogCache = { updatedAt: number; countries: Record<string, any[]> };
const CACHE_FILE = path.join(__dirname, 'vavoo_catalog_cache.json');
let currentCache: CatalogCache = { updatedAt: 0, countries: {} };

function readCacheFromDisk(): CatalogCache {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.countries) return j as CatalogCache;
  } catch {}
  return { updatedAt: 0, countries: {} };
}

function writeCacheToDisk(cache: CatalogCache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); } catch (e) { console.error('Cache write error:', e); }
}

function getClientIpFromReq(req: Request): string | null {
  try {
    const hdr = req.headers as Record<string, string | string[]>;
    const asStr = (v?: string | string[]) => Array.isArray(v) ? v[0] : (v || '');
    const stripPort = (ip: string) => ip.includes('.') && ip.includes(':') ? ip.split(':')[0] : ip;
    const isPrivate = (ip: string) => {
      const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (!m) return false;
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a === 10 || a === 127) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      return false;
    };
    const pick = (list: string[]): string | null => {
      for (const raw of list) { const ip = stripPort(raw.trim()); if (ip && !isPrivate(ip)) return ip; }
      return list.length ? stripPort(list[0].trim()) : null;
    };
    const xff = asStr(hdr['x-forwarded-for']); if (xff) { const got = pick(xff.split(',')); if (got) return got; }
    const xr = asStr(hdr['x-real-ip']); if (xr && !isPrivate(stripPort(xr))) return stripPort(xr);
    const ra: any = (req as any).ip || (req.socket as any)?.remoteAddress;
    return ra ? stripPort(String(ra)) : null;
  } catch { return null; }
}

async function getVavooSignature(clientIp: string | null) {
  const body: any = {
    token: 'tosFwQCJMS8qrW_AjLoHPQ41646J5dRNha6ZWHnijoYQQQoADQoXYSo7ki7O5-CsgN4CH0uRk6EEoJ0728ar9scCRQW3ZkbfrPfeCXW2VgopSW2FWDqPOoVYIuVPAOnXCZ5g',
    reason: 'app-blur', locale: 'de', theme: 'dark',
    metadata: { device: { type: 'Handset', brand: 'google', model: 'Pixel', name: 'sdk_gphone64_arm64', uniqueId: 'd10e5d99ab665233' }, os: { name: 'android', version: '13', abis: ['arm64-v8a','armeabi-v7a','armeabi'], host: 'android' }, app: { platform: 'android', version: '3.1.21', buildId: '289515000', engine: 'hbc85', signatures: ['6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e'], installer: 'app.revanced.manager.flutter' }, version: { package: 'tv.vavoo.app', binary: '3.1.21', js: '3.1.21' } },
    appFocusTime: 0, playerActive: false, playDuration: 0, devMode: false, hasAddon: true, castConnected: false,
    package: 'tv.vavoo.app', version: '3.1.21', process: 'app', firstAppStart: Date.now(), lastAppStart: Date.now(),
    ipLocation: clientIp || '', adblockEnabled: true, proxy: { supported: ['ss','openvpn'], engine: 'ss', ssVersion: 1, enabled: true, autoServer: true, id: 'de-fra' }, iap: { supported: false }
  };
  const headers: any = { 'user-agent': 'okhttp/4.11.0', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip' };
  vdbg('PING ipLocation', clientIp);
  const res = await fetch('https://www.vavoo.tv/api/app/ping', { method: 'POST', headers, body: JSON.stringify(body), timeout: 8000 } as any);
  if (!res.ok) return null;
  const json: any = await res.json();
  return json?.addonSig || null;
}

async function vavooCatalog(group: string, signature: string) {
  const headers: any = { 'user-agent': 'okhttp/4.11.0', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip', 'mediahubmx-signature': signature };
  const out: any[] = [];
  let cursor: any = 0;
  do {
    const body = { language: 'de', region: 'AT', catalogId: 'iptv', id: 'iptv', adult: false, search: '', sort: 'name', filter: { group }, cursor, clientVersion: '3.1.21' };
    const res = await fetch('https://vavoo.to/mediahubmx-catalog.json', { method: 'POST', headers, body: JSON.stringify(body), timeout: 10000 } as any);
    if (!res.ok) break;
    const j: any = await res.json();
    out.push(...(j?.items || []));
    cursor = j?.nextCursor;
  } while (cursor);
  return out;
}

async function resolveVavooPlay(url: string, signature: string): Promise<string | null> {
  const headers: any = { 'user-agent': 'MediaHubMX/2', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip', 'mediahubmx-signature': signature };
  const res = await fetch('https://vavoo.to/mediahubmx-resolve.json', { method: 'POST', headers, body: JSON.stringify({ language: 'de', region: 'AT', url, clientVersion: '3.1.21' }), timeout: 8000 } as any);
  if (!res.ok) return null;
  const j: any = await res.json();
  if (Array.isArray(j) && j[0]?.url) return String(j[0].url);
  if (j?.url) return String(j.url);
  return null;
}

const manifest: Manifest = {
  id: 'org.stremio.vavoo.clean',
  version: '1.0.0',
  name: 'VAVOO Clean',
  description: "Stremio addon that lists VAVOO TV channels and resolves clean HLS using the viewer's IP.",
  background: 'https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/backround.png',
  logo: 'https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/icon.png',
  types: ['tv'],
  idPrefixes: ['vavoo'],
  catalogs: SUPPORTED_COUNTRIES.map(c => ({ id: `vavoo_tv_${c.id}`, type: 'tv', name: `Vavoo TV • ${c.name}`, extra: [] })),
  resources: ['catalog', 'stream']
};

const builder = new addonBuilder(manifest);

// Catalog handler: list Vavoo channels for the selected country
builder.defineCatalogHandler(async ({ id, type }: { id: string; type: string }) => {
  if (type !== 'tv') return { metas: [] };
  const country = SUPPORTED_COUNTRIES.find(c => id === `vavoo_tv_${c.id}`);
  if (!country) return { metas: [] };
  // Serve only cached data; do not fetch live on demand
  const items: any[] = currentCache.countries[country.id] || [];
  const metas = items.map((it: any) => ({
    id: `vavoo:${encodeURIComponent(it?.name || 'Unknown')}|${encodeURIComponent(it?.url || '')}`,
    type: 'tv',
    name: it?.name || 'Unknown',
    poster: it?.poster || it?.image || undefined,
    description: it?.description || undefined
  }));
  return { metas };
});

// Stream handler: resolve using viewer IP via ipLocation in ping signature
builder.defineStreamHandler(async ({ id }: { id: string }, req: any) => {
  try {
    const [prefix, rest] = id.split(':');
    if (prefix !== 'vavoo') return { streams: [] };
    const [nameEnc, urlEnc] = (rest || '').split('|');
    const name = decodeURIComponent(nameEnc || '');
    const vavooUrl = decodeURIComponent(urlEnc || '');
    const clientIp = getClientIpFromReq(req as Request);
    vdbg('STREAM', { name, vavooUrl, clientIp });
    const sig = await getVavooSignature(clientIp);
    if (!sig) return { streams: [] };
    const resolved = await resolveVavooPlay(vavooUrl, sig);
    if (!resolved) return { streams: [] };
    const hdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string, string>;
    const streams: Stream[] = [
      { name: 'Vavoo', title: `[🏠] ${name}`, url: resolved, behaviorHints: { notWebReady: true, headers: hdrs, proxyHeaders: hdrs, proxyUseFallback: true } as any }
    ];
    return { streams };
  } catch (e) {
    console.error('Stream error:', e);
    return { streams: [] };
  }
});

// Minimal install/landing page
const router = getRouter(builder.getInterface());
const app = express();
app.set('trust proxy', true);
app.get('/', (_req: Request, res: Response) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  try {
    const filePath = path.join(__dirname, 'landing.html');
    const html = fs.readFileSync(filePath, 'utf8');
    res.send(html);
  } catch {
    res.send('<h1>VAVOO Clean</h1><p>Manifest: /manifest.json</p>');
  }
});
// Simple health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).send('ok');
});
// Cache status endpoint (not listing full data)
app.get('/cache/status', (_req: Request, res: Response) => {
  res.json({ updatedAt: currentCache.updatedAt, countries: Object.keys(currentCache.countries) });
});
app.use(router);

const port = Number(process.env.PORT || 7019);
// Initialize cache from disk, then schedule a daily refresh at 02:00 Europe/Rome
currentCache = readCacheFromDisk();
let refreshing = false;
async function refreshDailyCache() {
  if (refreshing) return; // prevent overlap
  refreshing = true;
  try {
    vdbg('Refreshing daily Vavoo catalog cache…');
    const sig = await getVavooSignature(null);
    if (!sig) throw new Error('No signature');
    const countries: Record<string, any[]> = {};
    for (const c of SUPPORTED_COUNTRIES) {
      try {
        // Try primary group, then a few fallbacks for regions that might have alternate group names
        const groupCandidates = [c.group, ...(c.id === 'nl' ? ['Netherlands', 'Holland'] : [])];
        let items: any[] = [];
        for (const g of groupCandidates) {
          items = await vavooCatalog(g, sig);
          if (items && items.length) break;
        }
        // lightweight retry if first attempt returns empty (transient upstream timeouts)
        if (!items || items.length === 0) {
          try { items = await vavooCatalog(c.group, sig); } catch {}
        }
        countries[c.id] = items || [];
        vdbg('Fetched', c.id, countries[c.id].length, 'items');
      } catch (e) {
        console.error('Fetch error for', c.id, e);
        countries[c.id] = [];
      }
    }
    currentCache = { updatedAt: Date.now(), countries };
    writeCacheToDisk(currentCache);
    vdbg('Cache refresh complete at', new Date(currentCache.updatedAt).toISOString());
  } catch (e) {
    console.error('Cache refresh failed:', e);
  } finally {
    refreshing = false;
  }
}

// If cache empty on startup, build once (still not per-request)
if (!currentCache.updatedAt) {
  refreshDailyCache().catch(() => {});
}

// Schedule at 02:00 Europe/Rome daily
cron.schedule('0 2 * * *', () => { refreshDailyCache().catch(() => {}); }, { timezone: 'Europe/Rome' });

app.listen(port, '0.0.0.0', () => console.log(`VAVOO Clean addon on http://localhost:${port}/manifest.json`));
