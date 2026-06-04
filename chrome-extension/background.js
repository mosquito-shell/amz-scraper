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

// === 裂变搜索: 纯店铺遍历递归 (PRD标准) ===
// 种子ASIN → 找跟卖店铺 → 挖爆款 → 找爆款的跟卖店铺 → 无限递归扩散, 直到采够
var fsProducts=[], fsSeenASIN={}, fsSeenStore={}, fsTarget=0, fsNestLevel=0, fsRunning=false;

function startFission(seed, target, filters, sender){
  if(fsRunning)return;
  fsRunning=true;fsProducts=[];fsSeenASIN={};fsSeenStore={};fsTarget=target;fsNestLevel=0;
  fsSeenASIN[seed]=true;
  notifyPopup({type:'fission-progress',phase:'store',msg:'🔍 种子: '+seed+' | 深度:0 | 0/'+target,pct:2});

  // 递归: digest ASIN → extract sellers → crawl store → for each top product → recurse
  var queue=[seed]; // ASIN queue for seller extraction
  function processNext(){
    if(!fsRunning||fsProducts.length>=fsTarget){finishFission();return;}
    if(!queue.length){
      // 队列耗尽 → 用关键词搜索填充更多ASIN
      notifyPopup({type:'fission-progress',phase:'store',msg:'🔍 队列耗尽, 关键词补充扩散... | '+fsProducts.length+'/'+fsTarget,pct:Math.min(90,2+Math.round(fsProducts.length/fsTarget*85))});
      searchFallback();return;
    }
    var asin=queue.shift();
    fsNestLevel++;
    fsDigestASIN(asin,function(storeUrls){
      if(!storeUrls.length||fsProducts.length>=fsTarget){processNext();return;}
      crawlStores(storeUrls.slice(0,5),function(newAsins){
        newAsins.forEach(function(a){if(!fsSeenASIN[a]){fsSeenASIN[a]=true;queue.push(a);}});
        var pct=Math.min(2+Math.round(fsProducts.length/fsTarget*85),90);
        notifyPopup({type:'fission-progress',phase:'store',msg:'🔍 深度:'+fsNestLevel+' | 队列:'+queue.length+' | '+fsProducts.length+'/'+fsTarget,pct:pct});
        setTimeout(processNext,1000);
      });
    });
  }

  // 关键词搜索补充 (当店铺遍历不够时)
  function searchFallback(){
    if(!fsRunning||fsProducts.length>=fsTarget){finishFission();return;}
    var lastProduct=fsProducts[fsProducts.length-1]||{};
    var kw=(lastProduct.brand||'')+' '+(lastProduct.title||'').split(' ').slice(0,3).join(' ');
    if(!kw.trim()||kw.trim().length<4)kw='related products';
    var url='https://www.amazon.com/s?k='+encodeURIComponent(kw.trim().substr(0,80));
    chrome.tabs.sendMessage(fissionActiveTab,{action:'fetchSearch',url:url},function(sr){
      if(sr&&sr.success){
        var asins=exA(sr.html);
        var added=0;
        asins.forEach(function(a){if(!fsSeenASIN[a]&&queue.length<fsTarget*3){fsSeenASIN[a]=true;queue.push(a);added++;}});
        notifyPopup({type:'fission-progress',phase:'store',msg:'🔍 关键词补充: +'+added+' ASINs | '+fsProducts.length+'/'+fsTarget,pct:Math.min(90,2+Math.round(fsProducts.length/fsTarget*85))});
      }
      setTimeout(processNext,1000);
    });
  }

  // Step 1: Digest an ASIN → get its seller store URLs
  function fsDigestASIN(asin,cb){
    chrome.tabs.sendMessage(fissionActiveTab,{action:'fetchSearch',url:'https://www.amazon.com/dp/'+asin},function(r){
      if(!r||!r.success||!r.html){cb([]);return;}
      var h=r.html;var stores=[];
      // Extract store links from offers section
      var re=/\/stores\/([A-Za-z0-9_-]+)/gi;var m;
      while((m=re.exec(h))!==null){var name=m[1].toLowerCase();if(name!=='amazon'&&name.length>1&&!fsSeenStore[name]){fsSeenStore[name]=true;stores.push('https://www.amazon.com/stores/'+name+'/page/01-'+name);}}
      // Also extract seller IDs from /s?me= links
      var re2=/\/s\?me=([A-Za-z0-9]+)/gi;
      while((m=re2.exec(h))!==null){var sid=m[1];if(sid.length>3&&!fsSeenStore[sid]){fsSeenStore[sid]=true;stores.push('https://www.amazon.com/s?me='+sid);}}
      cb(stores);
    });
  }

  // Step 2: Crawl each store → extract product ASIN list + fetch their details
  function crawlStores(storeUrls,cb){
    var allAsins=[],vi=0;
    function visitNext(){
      if(!fsRunning||vi>=storeUrls.length||fsProducts.length>=fsTarget){cb(allAsins);return;}
      chrome.tabs.sendMessage(fissionActiveTab,{action:'fetchSearch',url:storeUrls[vi]},function(sr){
        vi++;var asins=[];
        if(sr&&sr.success){asins=exA(sr.html).filter(function(a){return!fsSeenASIN[a];});}
        // Fetch details for all products from this store
        var di=0,todo=asins.slice(0,Math.min(10,target-fsProducts.length));
        function detailNext(){
          if(!fsRunning||di>=todo.length||fsProducts.length>=fsTarget){allAsins=allAsins.concat(todo.slice(di));setTimeout(visitNext,500);return;}
          fd(todo[di],function(d){
            if(d&&d.title){fsProducts.push(d);fsSeenASIN[d.asin]=true;allAsins.push(d.asin);}
            di++;var pct=Math.min(2+Math.round(fsProducts.length/fsTarget*85),90);
            notifyPopup({type:'fission-progress',phase:'store',msg:'🔍 深度:'+fsNestLevel+' | '+fsProducts.length+'/'+fsTarget,pct:pct});
            setTimeout(detailNext,1800+Math.random()*1200);
          });
        }
        detailNext();
      });
    }
    visitNext();
  }

  function finishFission(){
    fsProducts.forEach(function(p){p.brand=(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();});
    notifyPopup({type:'fission-done',products:fsProducts,msg:'✅ 裂变完成: '+fsProducts.length+' 个商品, 深度'+fsNestLevel});
    fsRunning=false;
  }

  processNext();
}

// 兼容 popup 旧调用 (startFissionSeller → 统一到 startFission)
var startFissionSeller = startFission;

function notifyPopup(data) {
  try { chrome.runtime.sendMessage(data); } catch(e) { /* popup closed, no listener */ }
}

// === 类目导出 (后台运行, 不中断) ===
function startExport(count, sender) {
  if (exportRunning) return;
  exportRunning = true; exportProducts = []; exportTotal = count; exportDone = 0;

  chrome.tabs.sendMessage(exportTab, { action: 'scrape' }, function(r) {
    if (!r || !r.success) { notifyPopup({ type: 'export-progress', msg: 'Failed to scrape', done: 0, total: 0, pct: 0 }); exportRunning = false; return; }
    var prods = (r.products || []).slice(0, Math.min(count, r.products.length));
    exportTotal = prods.length;
    notifyPopup({ type: 'export-progress', msg: 'Got ' + prods.length + '. Enriching...', done: 0, total: exportTotal, pct: 5 });

    function nx() {
      if (!exportRunning || exportDone >= exportTotal) {
        if (exportRunning) notifyPopup({ type: 'export-done', products: exportProducts, msg: 'Done! ' + exportProducts.length + ' products' });
        exportRunning = false; return;
      }
      chrome.tabs.sendMessage(exportTab, { action: 'getDetail', asin: prods[exportDone].asin }, function(dd) {
        exportProducts.push({
          asin: prods[exportDone].asin, title: prods[exportDone].title || '',
          brand: prods[exportDone].brand || '', link: 'https://www.amazon.com/dp/' + prods[exportDone].asin,
          image: prods[exportDone].image_url || '', price: prods[exportDone].price_usd || '',
          rating: prods[exportDone].rating || '', reviews: prods[exportDone].review_count || 0,
          shipping: prods[exportDone]._shipping || '',
          weight: (dd && dd.weight) || '',
          dims: (dd && dd.dimensions_cm ? Math.round(dd.dimensions_cm.length) + 'x' + Math.round(dd.dimensions_cm.width) + 'x' + Math.round(dd.dimensions_cm.height) : ''),
          bsr: (dd && dd.bsr) ? (dd.bsr[0] ? dd.bsr[0].rank : '') : ((prods[exportDone].bsr || [])[0] ? ((prods[exportDone].bsr || [])[0].rank || '') : ''),
          monthly: prods[exportDone].monthly || '',
          stock: (dd&&dd.stock)||0, sellerCount: (dd&&dd.sellerCount)||0
        });
        exportDone++;
        notifyPopup({ type: 'export-progress', msg: 'Enrich ' + exportDone + '/' + exportTotal, done: exportDone, total: exportTotal, pct: 5 + Math.round(exportDone / exportTotal * 90) });
        setTimeout(nx, 1500 + Math.random() * 1000);
      });
    }
    nx();
  });
}

// === 搜索页 fetch ===
function sp(url, cb) {
  if (!fissionActiveTab) { cb([]); return; }
  chrome.tabs.sendMessage(fissionActiveTab, { action: 'fetchSearch', url: url }, function(r) {
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
  if (!fissionActiveTab) { cb({ asin: asin, kw: 'related', link: 'https://www.amazon.com/dp/' + asin }); return; }
  chrome.tabs.sendMessage(fissionActiveTab, { action: 'fetchSearch', url: 'https://www.amazon.com/dp/' + asin }, function(r) {
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
