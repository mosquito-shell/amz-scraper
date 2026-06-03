/**
 * CF API Worker — 轻量后端
 * 功能: 权重同步 / 学习历史 / 选品数据中转 / 商标缓存
 *
 * 部署: wrangler deploy
 * KV: wrangler kv:namespace create "AMZ_DATA"
 */

const ALLOWED_ORIGINS = [
  'chrome-extension://*',
  'https://amz-dashboard.pages.dev',
  'https://*.pages.dev',
];

function cors(request, response) {
  const origin = request.headers.get('Origin') || '*';
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  response.headers.set('Access-Control-Max-Age', '86400');
  return response;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS preflight
  let response;
  if (method === 'OPTIONS') {
    response = new Response(null, { status: 204 });
    return cors(request, response);
  }

  try {
    // ===== Weights API =====
    if (path === '/api/weights' && method === 'GET') {
      const data = await env.AMZ_DATA.get('weights', 'json');
      response = json(data || { weights: null, history: [] });
      return cors(request, response);
    }

    if (path === '/api/weights' && method === 'POST') {
      const body = await request.json();
      const existing = await env.AMZ_DATA.get('weights_history', 'json') || [];

      // Store weights
      await env.AMZ_DATA.put('weights', JSON.stringify({
        weights: body.weights,
        last_update: new Date().toISOString(),
        source: body.source || 'plugin'
      }));

      // Append to history
      if (body.history) {
        existing.push(...body.history);
        // Keep last 100 entries
        const trimmed = existing.slice(-100);
        await env.AMZ_DATA.put('weights_history', JSON.stringify(trimmed));
      }

      // Update timestamp
      await env.AMZ_DATA.put('last_sync', new Date().toISOString());

      response = json({ ok: true, updated: new Date().toISOString() });
      return cors(request, response);
    }

    // ===== Learn History API =====
    if (path === '/api/learn-history' && method === 'GET') {
      const data = await env.AMZ_DATA.get('weights_history', 'json') || [];
      response = json(data);
      return cors(request, response);
    }

    if (path === '/api/learn-history' && method === 'POST') {
      const body = await request.json();
      const existing = await env.AMZ_DATA.get('weights_history', 'json') || [];
      if (Array.isArray(body)) {
        existing.push(...body);
      } else {
        existing.push(body);
      }
      const trimmed = existing.slice(-100);
      await env.AMZ_DATA.put('weights_history', JSON.stringify(trimmed));
      response = json({ ok: true, count: trimmed.length });
      return cors(request, response);
    }

    // ===== Products API =====
    if (path === '/api/products' && method === 'GET') {
      const data = await env.AMZ_DATA.get('products', 'json') || [];
      // Clean brand names on output
      const clean = data.map(function(p) {
        p.brand = (p.brand || '').replace(/Visit the /g, '').replace(/ Store$/g, '').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi, '').trim();
        return p;
      });
      response = json(clean);
      return cors(request, response);
    }

    if (path === '/api/products' && method === 'POST') {
      const body = await request.json();
      // body: { products: [...], source: 'export'|'fission', time: '...' }
      const existing = await env.AMZ_DATA.get('products', 'json') || [];

      if (body.products && Array.isArray(body.products)) {
        // Deduplicate by ASIN
        const seen = new Set(existing.map(p => p.asin));
        const fresh = body.products.filter(p => !seen.has(p.asin));
        const merged = [...existing, ...fresh];
        // Cap at 5000 products
        const trimmed = merged.slice(-5000);
        await env.AMZ_DATA.put('products', JSON.stringify(trimmed));
        await env.AMZ_DATA.put('last_products_update', new Date().toISOString());
        response = json({ ok: true, total: trimmed.length, added: fresh.length });
      } else {
        response = json({ ok: false, error: 'no products array' }, 400);
      }
      return cors(request, response);
    }

    // ===== Trademark Cache (shared, populated by extension) =====
    if (path === '/api/trademark-batch' && method === 'POST') {
      const body = await request.json();
      const brands = body.brands || [];
      const results = {};
      const cached = await env.AMZ_DATA.get('tm_cache', 'json') || {};
      let dirty = false;

      for (const brand of brands) {
        const clean = brand.replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi, '').toLowerCase().trim();
        if (!clean || clean === 'generic' || clean === 'from the author') { results[brand] = 0; continue; }
        if (cached[clean] !== undefined) { results[brand] = cached[clean]; continue; }
        // Not in shared cache — client should query USPTO/WIPO from browser
        results[brand] = null; // null = not cached, client must look up
      }

      response = json(results);
      return cors(request, response);
    }

    // ===== Trademark Lookup (USPTO + WIPO, cached 10yr per PRD) =====
    if (path === '/api/trademark' && method === 'GET') {
      const brand = url.searchParams.get('q');
      if (!brand) { response = json({ error: 'missing q param' }, 400); return cors(request, response); }
      const clean = brand.toLowerCase().trim();

      // Check KV cache first
      const cached = await env.AMZ_DATA.get('tm_cache', 'json') || {};
      if (cached[clean] !== undefined) {
        response = json({ registered: cached[clean], brand: clean, source: 'cache' });
        return cors(request, response);
      }

      // Query USPTO
      let registered = 0;
      let source = 'none';
      try {
        const usptoResp = await fetch(
          'https://tsdr.uspto.gov/tsdr/api/v1/search?q=' + encodeURIComponent(clean) + '&pageSize=5&page=0',
          { headers: { 'Accept': 'application/json' } }
        );
        if (usptoResp.ok) {
          const data = await usptoResp.json();
          const results = data.searchResults || data.results || (Array.isArray(data) ? data : []);
          if (results.length) {
            const bc = clean.replace(/\s+/g, '');
            for (const r of results) {
              const mn = (r.markVerbalElementText || r.name || r.markIdentification || '').replace(/\s+/g, '').toLowerCase();
              if (mn === bc || mn.indexOf(bc) > -1 || bc.indexOf(mn) > -1) {
                const st = (r.status || r.statusCode || '').toLowerCase();
                if (/live|registered|published|notice of allowance|approved/.test(st)) {
                  registered = 1; source = 'uspto'; break;
                }
              }
            }
          }
        }
      } catch (e) { /* USPTO failed, continue to WIPO */ }

      // Fallback: WIPO Global Brand Database
      if (registered === 0) {
        try {
          const wipoResp = await fetch(
            'https://api.branddb.wipo.int/api/v2/brand/search?q=' + encodeURIComponent(clean) + '&size=5',
            { headers: { 'Accept': 'application/json' } }
          );
          if (wipoResp.ok) {
            const wdata = await wipoResp.json();
            const hits = (wdata && wdata.hits) ? wdata.hits : [];
            if (hits.length) {
              const bc = clean.replace(/\s+/g, '');
              for (const h of hits) {
                const mn = (h.markName || h.brandName || '').replace(/\s+/g, '').toLowerCase();
                if (mn.indexOf(bc) > -1 || bc.indexOf(mn) > -1) {
                  registered = 1; source = 'wipo'; break;
                }
              }
            }
          }
        } catch (e) { /* WIPO failed, keep 0 */ }
      }

      // Cache result in KV (PRD: 10 year cache)
      cached[clean] = registered;
      await env.AMZ_DATA.put('tm_cache', JSON.stringify(cached));

      response = json({ registered, brand: clean, source });
      return cors(request, response);
    }

    // Legacy batch TM cache endpoints
    if (path === '/api/tm-cache' && method === 'GET') {
      const data = await env.AMZ_DATA.get('tm_cache', 'json') || {};
      response = json(data);
      return cors(request, response);
    }

    if (path === '/api/tm-cache' && method === 'POST') {
      const body = await request.json();
      const existing = await env.AMZ_DATA.get('tm_cache', 'json') || {};
      Object.assign(existing, body);
      await env.AMZ_DATA.put('tm_cache', JSON.stringify(existing));
      response = json({ ok: true, count: Object.keys(existing).length });
      return cors(request, response);
    }

    // ===== Status / Health =====
    if (path === '/api/status' || path === '/') {
      const lastSync = await env.AMZ_DATA.get('last_sync') || 'never';
      const weightsData = await env.AMZ_DATA.get('weights', 'json');
      const productsCount = ((await env.AMZ_DATA.get('products', 'json')) || []).length;
      response = json({
        ok: true,
        service: 'amz-api-worker',
        last_sync: lastSync,
        weights_version: weightsData ? weightsData.last_update : 'none',
        products_count: productsCount,
        time: new Date().toISOString()
      });
      return cors(request, response);
    }

    // ===== Proxy Health Check =====
    if (path === '/api/proxy-status' && method === 'GET') {
      const proxies = [
        { name: 'proxy-1', url: 'https://proxy.tsscjn.top' },
        { name: 'proxy-2', url: 'https://amz-proxy-2.3203916089.workers.dev' },
        { name: 'proxy-3', url: 'https://amz-proxy-3.3203916089.workers.dev' },
        { name: 'proxy-4', url: 'https://amz-proxy-4.3203916089.workers.dev' },
      ];
      const results = await Promise.all(proxies.map(async (p) => {
        const start = Date.now();
        try {
          const r = await fetch(p.url + '?url=' + encodeURIComponent('https://httpbin.org/ip'), { headers: { 'Accept': 'text/html' } });
          const ms = Date.now() - start;
          return { name: p.name, url: p.url, ok: r.ok, status: r.status, latency_ms: ms, online: r.ok || r.status < 500 };
        } catch (e) {
          return { name: p.name, url: p.url, ok: false, error: e.message, latency_ms: Date.now() - start, online: false };
        }
      }));
      response = json({
        updated: new Date().toISOString(),
        total: results.filter(r => r.online).length,
        proxies: results
      });
      return cors(request, response);
    }

    // 404
    response = json({ error: 'not found' }, 404);

  } catch (err) {
    response = json({ error: err.message }, 500);
  }

  return cors(request, response);
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};
