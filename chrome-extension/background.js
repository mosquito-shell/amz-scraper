/**
 * 后台 Service Worker — 商标查询 + 裂变搜索 + 代理
 */
'use strict';

var tmCache = {};
var fissionRunning = false, fissionSeen = {}, fissionQueue = [], fissionEnriched = [];
var fissionDone = 0, fissionTotal = 0, fissionTarget = 0, fissionActiveTab = null;
var fissionCb = {}; // keyword expansion counter
var fissionFilters = {}; // user-selected filters

// === Export state (类目导出, 后台运行不中断) ===
var exportRunning = false, exportProducts = [], exportTotal = 0, exportDone = 0, exportTab = null;

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  // === 商标 ===
  if (request.action === 'checkTrademark') {
    checkTrademark(request.brand, function(result) { sendResponse(result); });
    return true;
  }
  if (request.action === 'checkTrademarksBatch') {
    checkTrademarksBatch(request.brands, function(results) { sendResponse(results); });
    return true;
  }
  // === 裂变搜索 ===
  if (request.action === 'startFission') {
    fissionActiveTab = request.tabId || (sender.tab ? sender.tab.id : null);
    startFission(request.seed, request.target, request.filters, sender);
    sendResponse({ ok: true });
    return false;
  }
  // F: 店铺遍历裂变
  if (request.action === 'startFissionSeller') {
    fissionActiveTab = request.tabId || (sender.tab ? sender.tab.id : null);
    startFissionSeller(request.seed, request.target, sender);
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'cancelFission') {
    fissionRunning = false;
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'getFissionState') {
    sendResponse({
      running: fissionRunning,
      enriched: fissionEnriched,
      done: fissionDone,
      total: fissionTotal,
      queueSize: fissionQueue.length
    });
    return false;
  }
  // === 类目导出 (后台运行, 不中断) ===
  if (request.action === 'startExport') {
    exportTab = request.tabId || (sender.tab ? sender.tab.id : null);
    startExport(request.count || 50, sender);
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'cancelExport') {
    exportRunning = false;
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'getExportState') {
    sendResponse({
      running: exportRunning,
      products: exportProducts,
      done: exportDone,
      total: exportTotal
    });
    return false;
  }
  return false;
});

// === 裂变搜索: 关键词搜索 + fd详情 (PRD标准, 搜索页有data-asin稳定提取) ===
var fsProducts=[], fsSeenASIN={}, fsTarget=0, fsRunning=false, fsAllRawASINs=[];

function startFission(seed, target, filters, sender){
  if(fsRunning)return;
  fsRunning=true;fsProducts=[];fsSeenASIN={};fsTarget=target;fsAllRawASINs=[];fsConsecutive=0;
  notifyPopup({type:'fission-progress',phase:'search',msg:'🔍 种子: '+seed+' | 0/'+target,pct:2});

  // Global watchdog: force finish after 5 minutes
  var watchdog=setTimeout(function(){if(fsRunning){fsRunning=false;finishFission();}},300000);

  // Step 1: Fetch seed detail first for keywords
  fd(seed,function(d){
    if(d&&d.title){fsProducts.push(d);}
    var kws=extractKeywords(d||{title:seed,brand:''});
    fsAllRawASINs.push(seed);fsSeenASIN[seed]=true;
    expandLoop(kws);
  });

  function extractKeywords(p){
    var titleWords=(p.title||'').toLowerCase().split(/[\s\/\-]+/).filter(function(w){return w.length>4&&!/^\d/.test(w);});
    var brand=(p.brand||'').toLowerCase().replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();
    if(brand&&brand.length>2&&brand!=='generic')titleWords.unshift(brand);
    // Remove duplicates while preserving order
    var seen={},unique=[];
    titleWords.forEach(function(w){if(!seen[w]){seen[w]=true;unique.push(w);}});
    return unique;
  }

  // 搜索 → 抓ASIN → 补详情 → 循环
  var usedKws={}, kv=0;
  function expandLoop(kws){
    if(!fsRunning||fsProducts.length>=fsTarget){finishFission();return;}
    if(fsConsecutive++>12){finishFission();return;}

    var kw=kws[kv++];if(!kw){kv=0;kw=kws[kv];}
    if(!kw||usedKws[kw]){setTimeout(function(){expandLoop(kws);},200);return;}
    usedKws[kw]=true;fsConsecutive=0;

    var url='https://www.amazon.com/s?k='+encodeURIComponent(kw);
    notifyPopup({type:'fission-progress',phase:'search',msg:'🔍 搜索: '+kw+' | '+fsProducts.length+'/'+fsTarget,pct:10+Math.round(fsProducts.length/fsTarget*20)});

    chrome.tabs.sendMessage(fissionActiveTab,{action:'fetchSearch',url:url},function(sr){
      if(!sr||!sr.success){fsConsecutive++;setTimeout(function(){expandLoop(kws);},500);return;}
      var asins=exA(sr.html);
      var fresh=[];asins.forEach(function(a){if(!fsSeenASIN[a]){fsSeenASIN[a]=true;fresh.push(a);}});
      if(!fresh.length){fsConsecutive++;setTimeout(function(){expandLoop(kws);},500);return;}

      var fi=0,maxFetch=Math.min(fresh.length,fsTarget-fsProducts.length+10);
      function fetchOne(){
        if(!fsRunning||fi>=maxFetch||fsProducts.length>=fsTarget){
          fsProducts.slice(-5).forEach(function(p){
            var sub=extractKeywords(p);
            sub.forEach(function(w){if(!usedKws[w]){kws.push(w);}});
          });
          setTimeout(function(){expandLoop(kws);},300);return;
        }
        var af=fresh[fi];fi++;
        // Retry fd up to 2 times for network errors
        var retry=0;
        function doFd(){
          fd(af,function(d){
            if(d&&d.title){fsProducts.push(d);fsConsecutive=0;}
            else if(!d||d.err||retry<1){retry++;setTimeout(doFd,2000);return;}
            var pct=10+Math.round(fsProducts.length/fsTarget*85);
            notifyPopup({type:'fission-progress',phase:'detail',msg:'📦 '+fsProducts.length+'/'+fsTarget+' products',pct:Math.min(pct,99)});
            setTimeout(fetchOne,1500+Math.random()*1000);
          });
        }
        doFd();
      }
      fetchOne();
    });
  }

  function finishFission(){
    if(!fsRunning) return;
    fsProducts.forEach(function(p){p.brand=(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();});
    notifyPopup({type:'fission-done',products:fsProducts,msg:'✅ 裂变完成: '+fsProducts.length+' 个商品'});
    fsRunning=false;
  }
}

var startFissionSeller = startFission;

function notifyPopup(data) {
  try { chrome.runtime.sendMessage(data); } catch(e) { /* popup closed, no listener */ }
}

// === 类目导出 (后台运行, 不中断) ===
function startExport(count, sender) {
  if (exportRunning) return;
  exportRunning = true; exportProducts = []; exportTotal = count; exportDone = 0; var exportSent = 0;

  chrome.tabs.sendMessage(exportTab, { action: 'scrape' }, function(r) {
    if (!r || !r.success) { notifyPopup({ type: 'export-progress', msg: 'Failed to scrape', done: 0, total: 0, pct: 0 }); exportRunning = false; return; }
    var prods = (r.products || []).slice(0, Math.min(count, r.products.length));
    exportTotal = prods.length;
    if (!exportTotal) { notifyPopup({ type: 'export-done', products: [], msg: '0 products found' }); exportRunning = false; return; }
    notifyPopup({ type: 'export-progress', msg: 'Got ' + exportTotal + '. Enriching...', done: 0, total: exportTotal, pct: 5 });

    function nx() {
      if (!exportRunning || exportSent >= exportTotal) {
        // Wait for pending callbacks (max 30s)
        var waited = 0;
        function checkDone() {
          if (exportProducts.length >= exportTotal || waited > 30 || !exportRunning) {
            notifyPopup({ type: 'export-done', products: exportProducts, msg: 'Done! ' + exportProducts.length + ' products' });
            exportRunning = false; return;
          }
          waited++; setTimeout(checkDone, 1000);
        }
        checkDone(); return;
      }
      var idx = exportSent; exportSent++;
      fd(prods[idx].asin, function(d) {
        exportProducts.push({
          asin: prods[idx].asin, title: prods[idx].title || (d&&d.title) || '',
          brand: prods[idx].brand || (d&&d.brand) || '', link: 'https://www.amazon.com/dp/' + prods[idx].asin,
          image: prods[idx].image_url || (d&&d.image) || '', price: prods[idx].price_usd || (d&&d.price) || '',
          rating: prods[idx].rating || (d&&d.rating) || '', reviews: prods[idx].review_count || (d&&d.reviews) || 0,
          shipping: prods[idx]._shipping || (d&&d.shipping) || '',
          weight: (d && d.weight) || '', dims: (d && d.dims) || '',
          bsr: (d && d.bsr) || ((prods[idx].bsr || [])[0] ? ((prods[idx].bsr || [])[0].rank || '') : ''),
          monthly: prods[idx].monthly || (d&&d.monthly) || '', stock: (d&&d.stock)||0, sellerCount: (d&&d.sellerCount)||0
        });
        notifyPopup({ type: 'export-progress', msg: 'Enrich ' + exportProducts.length + '/' + exportTotal, done: exportProducts.length, total: exportTotal, pct: 5 + Math.round(exportProducts.length / exportTotal * 90) });
      });
      setTimeout(nx, 1800 + Math.random() * 1200);
    }
    nx();
  });
}

// === 搜索页 fetch ===
function sp(url, cb) {
  var tab = fissionActiveTab || exportTab;
  if (!tab) { cb([]); return; }
  chrome.tabs.sendMessage(tab, { action: 'fetchSearch', url: url }, function(r) {
    if (r && r.success) {
      var a = exA(r.html);
      a.forEach(function(x) { fissionQueue.push(x); });
      cb(a);
    } else { cb([]); }
  });
}

function exA(h) {
  var a = [], seen = {};
  var re = /data-asin="([A-Z0-9]{10})"/g, m;
  while ((m = re.exec(h)) !== null) { if (!seen[m[1]]) { seen[m[1]] = true; a.push(m[1]); } }
  // Fallback: /dp/ URLs for store pages (no data-asin attributes)
  if (a.length < 3) {
    var re2 = /\/dp\/([A-Z0-9]{10})/g;
    while ((m = re2.exec(h)) !== null) { if (!seen[m[1]]) { seen[m[1]] = true; a.push(m[1]); } }
  }
  return a;
}

// === 详情页 fetch ===
function fd(asin, cb) {
  var tab = fissionActiveTab || exportTab;
  if (!tab) { cb({ asin: asin, kw: 'related', link: 'https://www.amazon.com/dp/' + asin }); return; }
  chrome.tabs.sendMessage(tab, { action: 'fetchSearch', url: 'https://www.amazon.com/dp/' + asin }, function(r) {
    if (!r || !r.success || !r.html || r.html.length < 5000) {
      cb({ asin: asin, kw: 'related', link: 'https://www.amazon.com/dp/' + asin });
      return;
    }
    var h = r.html;
    var t = '', bm = h.match(/id="productTitle"[^>]*>([^<]+)/); if (bm) t = bm[1].trim();
    var br = '', brM = h.match(/id="bylineInfo"[^>]*>([^<]+)/);
    if (brM) br = brM[1].trim().replace(/Visit the /, '').replace(/ Store/, '');
    if (!br) { var b2 = h.match(/Brand<\/[^>]*>\s*<[^>]*>\s*([^<]+)/i); if (b2) br = b2[1].trim(); }
    if (!br) { var b3 = h.match(/data-feature-name="bylineInfo"[^>]*>\s*([^<]+)/i); if (b3) br = b3[1].trim(); }
    if (!br) { var b4 = h.match(/href="[^"]*\/stores\/[^"]*"[^>]*>\s*([^<]+)<\/a>/i); if (b4) br = b4[1].trim(); }
    var pr = '', prM = h.match(/priceblock_ourprice[^>]*>\$(\d+\.?\d{0,2})/);
    if (!prM) prM = h.match(/a-price-whole[^>]*>(\d+)[^<]*<[^>]*a-price-fraction[^>]*>(\d+)/);
    if (prM && prM[2]) pr = prM[1] + '.' + prM[2];
    if (!prM) { var cm = h.match(/id="corePrice[^"]*"[^>]*>[^$]*\$(\d+\.?\d{0,2})/); if (cm) pr = cm[1]; }
    if (!pr) { var bm2 = h.match(/>\$(\d+\.?\d{0,2})</); if (bm2) pr = bm2[1]; }
    var ra = '', raM = h.match(/(\d\.\d).*?out of 5/i); if (raM) ra = raM[1];
    var rv = '', rvM = h.match(/([\d,]+)\s*(?:rating|review)/i); if (rvM) rv = rvM[1].replace(/,/g, '');
    var bs = '', bsM = h.match(/Best Sellers Rank[^#]*#([\d,]+)/); if (bsM) bs = bsM[1];
    var wt = '', wtM = h.match(/Item Weight[^>]*>\s*(\d+\.?\d*)\s*(pounds?|ounces?|kg|Pounds?|Ounces?|g)/i);
    if (!wtM) wtM = h.match(/Weight[:\s]*\s*(\d+\.?\d*)\s*(pounds?|ounces?|kg)/i);
    if (wtM) { var wv = parseFloat(wtM[1]), wu = wtM[2].toLowerCase(); wv = /ounce/.test(wu) ? +(wv / 35.274).toFixed(2) : /pound/.test(wu) ? +(wv / 2.205).toFixed(2) : wv; wt = parseFloat(wv) + ' kg'; }
    var dm = '', dmM = h.match(/Dimensions[^<]*<\/(?:span|td)[^>]*>\s*<[^>]*>\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*(inches?|cm)?/i);
    if (!dmM) dmM = h.match(/Dimensions[:\s]*\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*(inches?|cm)?/i);
    if (dmM) { var dl2 = parseFloat(dmM[1]), dw = parseFloat(dmM[2]), dh = parseFloat(dmM[3]), du = (dmM[4] || '').toLowerCase(); if (du.indexOf('in') >= 0) { dl2 = Math.round(dl2 * 2.54 * 10) / 10; dw = Math.round(dw * 2.54 * 10) / 10; dh = Math.round(dh * 2.54 * 10) / 10; } dm = dl2 + 'x' + dw + 'x' + dh; }
    var mo = '', moM = h.match(/(\d+[Kk]?\+?)\s*bought in past month/i); if (moM) mo = moM[1];
    var sh = ''; if (/prime|fulfillment by amazon/i.test(h)) sh = 'FBA'; else if (/free shipping/i.test(h)) sh = 'MFN';
    var isBS = /best seller|#1 best/i.test(h) ? 1 : 0;
    // 多层图片提取 (Match sidepanel/content.js patterns)
    var img = '';
    var im = h.match(/"hiRes"\s*:\s*"([^"]+)"/) || h.match(/"hiRes"[^"]*"([^"]+)"/);
    if (im) { img = im[1]; }
    if (!img) { im = h.match(/id="landingImage"[^>]*src="([^"]+)"/); if (im) img = im[1]; }
    if (!img) { im = h.match(/id="imgTagWrapperId"[^>]*<img[^>]*src="([^"]+)"/); if (im) img = im[1]; }
    if (!img) { im = h.match(/"large"\s*:\s*"([^"]+)"/); if (im) img = im[1]; }
    if (!img) { im = h.match(/"mainImageUrl"\s*:\s*"([^"]+)"/); if (im) img = im[1]; }
    if (!img) { im = h.match(/<img[^>]*id="landingImage"[^>]*data-old-hires="([^"]+)"/); if (im) img = im[1]; }
    if (!img) { im = h.match(/<img[^>]+src="([^"]*\/images\/I\/[^"]+)"/i); if (im) img = im[1]; }
    if (!img) { im = h.match(/https:\/\/[^"]*amazon[^"]*\/images\/I\/[^"]+/i); if (im) img = im[0]; }
    if (img && img.startsWith('//')) img = 'https:' + img;
    var kw = ''; if (t) { var wds = t.split(/\s+/).filter(function(w) { return w.length > 4 }); kw = wds.slice(0, 3).join(' '); }
    if (br && br.length > 1 && br !== 'Generic' && !kw) kw = br;
    br = br.replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi, '').trim();
    var sc = 0, scM = h.match(/(\d+)\s*(?:new|other\s*seller|offer)/i) || h.match(/(\d+)\s*(?:from|seller)/i); if (scM) sc = parseInt(scM[1]) || 0;
    var stk = 0, stkM = h.match(/In Stock[^0-9]*(\d+)/i) || h.match(/(\d+)\s*(?:left|remain)/i); if (stkM) stk = parseInt(stkM[1]) || 0;
    cb({ asin: asin, title: t, brand: br, price: pr, rating: ra, reviews: rv, bsr: bs, weight: wt, dims: dm, monthly: mo, image: img, link: 'https://www.amazon.com/dp/' + asin, kw: kw, shipping: sh, bs: isBS, sellerCount: sc, stock: stk });
  });
}

// === 商标查询 ===
function checkTrademark(brand, callback) {
  var key = brand.toLowerCase().trim();
  if (!key) { callback({ registered: 0, source: 'empty' }); return; }
  if (tmCache[key] !== undefined) { callback(tmCache[key]); return; }
  getUSPTO(brand, function(result) { tmCache[key] = result; callback(result); });
}

function checkTrademarksBatch(brands, callback) {
  var results = {}, pending = [], done = 0;
  brands.forEach(function(brand) {
    var key = brand.toLowerCase().trim();
    if (!key) { results[brand] = { registered: 0, source: 'empty' }; return; }
    if (tmCache[key] !== undefined) { results[brand] = tmCache[key]; return; }
    pending.push(brand);
  });
  if (!pending.length) { callback(results); return; }
  pending.forEach(function(brand) {
    getUSPTO(brand, function(result) {
      var key = brand.toLowerCase().trim();
      tmCache[key] = result; results[brand] = result; done++;
      if (done >= pending.length) {
        var toCache = {};
        Object.keys(results).forEach(function(b) {
          var r = results[b];
          if (r && r.registered !== undefined) toCache[b.toLowerCase().trim()] = r.registered;
        });
        try { fetch('https://api.tsscjn.top/api/tm-cache', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toCache) }); } catch (e) { }
        callback(results);
      }
    });
  });
}

// PRD: WIPO 国家筛选 — 获取品牌注册国家列表
function checkTrademarkCountries(brand, callback) {
  var cleanBrand = brand.toLowerCase().trim();
  getUSPTO(cleanBrand, function(r) {
    var c = r.countries || [];
    if (!r.registered) { tryWIPO(cleanBrand, function(wr) { callback({registered:wr.registered,countries:(wr.countries||[]),sources:['uspto','wipo']}); }); }
    else { callback({registered:1,countries:c,sources:['uspto']}); }
  });
}

// A: 在 USPTO/WIPO 查询结果中已包含 countries 字段, see getUSPTO/tryWIPO

function getUSPTO(brand, callback) {
  var cleanBrand = brand.toLowerCase().trim();
  fetch('https://tsdr.uspto.gov/tsdr/api/v1/search?q=' + encodeURIComponent(cleanBrand) + '&pageSize=10&page=0', { headers: { 'Accept': 'application/json' } })
    .then(function(resp) { if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.json(); })
    .then(function(data) {
      var results = Array.isArray(data) ? data : (data.searchResults || data.results || []);
      if (!results.length) { return tryWIPO(cleanBrand, callback); }
      function norm(s) { return (s || '').replace(/\s+/g, '').toLowerCase(); }
      var bc = norm(cleanBrand), exact = null;
      for (var i = 0; i < results.length; i++) { var n = norm(results[i].markVerbalElementText || results[i].name || results[i].markIdentification || ''); if (n === bc) { exact = results[i]; break; } }
      if (!exact) { for (var j = 0; j < results.length; j++) { var n2 = norm(results[j].markVerbalElementText || results[j].name || results[j].markIdentification || ''); if (n2.indexOf(bc) > -1 || bc.indexOf(n2) > -1) { exact = results[j]; break; } } }
      var match = exact || results[0];
      var st = (match.status || match.statusCode || '').toLowerCase();
      callback({ registered: (/live|registered|published for opposition|notice of allowance|approved/.test(st)) ? 1 : 0, source: 'uspto', name: match.markVerbalElementText || match.name || '', regNum: match.registrationNumber || match.serialNumber || '', status: match.status || '', total: results.length, exactMatch: !!exact });
    })
    .catch(function(err) { tryWIPO(cleanBrand, callback); });
}

// WIPO Global Brand Database fallback (覆盖非美国注册)
function tryWIPO(cleanBrand, callback) {
  fetch('https://api.branddb.wipo.int/api/v2/brand/search?q=' + encodeURIComponent(cleanBrand) + '&size=5', { headers: { 'Accept': 'application/json' } })
    .then(function(resp) { if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.json(); })
    .then(function(data) {
      var hits = (data && data.hits) ? data.hits : [];
      if (!hits.length) { callback({ registered: 0, source: 'wipo', total: 0, countries: [] }); return; }
      var bc = cleanBrand.replace(/\s+/g, '').toLowerCase();
      var countries = [];
      for (var i = 0; i < hits.length; i++) {
        var mn = (hits[i].markName || hits[i].brandName || '').replace(/\s+/g, '').toLowerCase();
        var c = hits[i].country || hits[i].designationCountry || '';
        if (c && countries.indexOf(c) < 0) countries.push(c);
        if (mn.indexOf(bc) > -1 || bc.indexOf(mn) > -1) {
          callback({ registered: 1, source: 'wipo', name: hits[i].markName || hits[i].brandName || '', total: hits.length, countries: countries });
          return;
        }
      }
      callback({ registered: 0, source: 'wipo', total: hits.length, countries: countries });
    })
    .catch(function(err) { callback({ registered: 0, source: 'error', error: err.message }); });
}
