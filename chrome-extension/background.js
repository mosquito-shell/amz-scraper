/**
 * 后台 Service Worker — 商标查询 + 裂变搜索 + 类目导出
 */
'use strict';

var tmCache = {};
var fissionActiveTab = null;
var fissionRunning = false;

// === Export state ===
var exportRunning = false, exportProducts = [], exportTotal = 0, exportTab = null;

// === Fission state ===
var fsProducts=[], fsSeenASIN={}, fsTarget=0, fsRunning=false, fsKws=[], fsUsedKws={}, fsKi=0, fsConsecutive=0, fsWatchdog=null;

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === 'checkTrademark') {
    checkTrademark(request.brand, function(result) { sendResponse(result); });
    return true;
  }
  if (request.action === 'checkTrademarksBatch') {
    checkTrademarksBatch(request.brands, function(results) { sendResponse(results); });
    return true;
  }
  if (request.action === 'startFission') {
    fissionActiveTab = request.tabId || (sender.tab ? sender.tab.id : null);
    startFission(request.seed, request.target, request.filters, sender);
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'startFissionSeller') {
    fissionActiveTab = request.tabId || (sender.tab ? sender.tab.id : null);
    startFissionSeller(request.seed, request.target, sender);
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'cancelFission') {
    fsRunning = false; fissionRunning = false;
    clearTimeout(fsWatchdog);
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'getFissionState') {
    sendResponse({
      running: fsRunning || fissionRunning,
      done: fsRunning,
      enriched: fsProducts,
      total: fsTarget,
      queueSize: fsKws.length
    });
    return false;
  }
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
      done: exportProducts.length,
      total: exportTotal
    });
    return false;
  }
  return false;
});

function notifyPopup(data) {
  try { chrome.runtime.sendMessage(data); } catch(e) { /* popup closed */ }
}

// ============================================================
// 裂变搜索: 种子 → getDetail 拿标题 → 用标题词搜索 → enrichBatch
// ============================================================

function startFission(seed, target, filters, sender){
  if(fsRunning) return;
  fsRunning=true; fsProducts=[]; fsSeenASIN={}; fsTarget=target;
  fsKws=[]; fsUsedKws={}; fsKi=0; fsConsecutive=0;
  fsSeenASIN[seed]=true;

  notifyPopup({type:'fission-progress',phase:'search',msg:'种子: '+seed+' | 获取标题...',pct:2});
  fsWatchdog=setTimeout(function(){if(fsRunning)finishFission();},300000);

  // Step1: 用 enrichBatch 拿种子的标题, 从中提取关键词
  chrome.tabs.sendMessage(fissionActiveTab, {action:'enrichBatch',asins:[seed]}, function(r){
    if(r && r.success && r.products && r.products[0]){
      var d=r.products[0];
      if(d.title) fsProducts.push(d);
      var kws=extractKeywords(d);
      fsKws=kws;
    } else {
      fsKws=[seed];
    }
    setTimeout(expandLoop, 300);
  });

  function extractKeywords(p){
    var t=(p.title||'').toLowerCase();
    var b=(p.brand||'').toLowerCase().replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();
    var w=t.split(/[\s\/\-]+/).filter(function(x){return x.length>4&&!/^\d/.test(x);});
    if(b&&b.length>2&&b!=='generic') w.unshift(b);
    var s={},u=[];
    w.forEach(function(x){if(!s[x]){s[x]=true;u.push(x);}});
    return u;
  }

  function expandLoop(){
    if(!fsRunning||fsProducts.length>=fsTarget){finishFission();return;}
    if(fsConsecutive++>20){finishFission();return;}

    if(fsKi>=fsKws.length){fsKi=0;}
    var kw=fsKws[fsKi++];
    if(!kw||fsUsedKws[kw]){setTimeout(expandLoop,200);return;}
    fsUsedKws[kw]=true; fsConsecutive=0;

    var url='https://www.amazon.com/s?k='+encodeURIComponent(kw);
    notifyPopup({type:'fission-progress',phase:'search',msg:'搜索: '+kw+' | '+fsProducts.length+'/'+fsTarget,pct:10+Math.round(fsProducts.length/fsTarget*20)});

    chrome.tabs.sendMessage(fissionActiveTab,{action:'fetchSearch',url:url},function(sr){
      if(!sr||!sr.success){fsConsecutive++;setTimeout(expandLoop,800);return;}
      var fresh=exA(sr.html).filter(function(a){return!fsSeenASIN[a];});
      fresh.forEach(function(a){fsSeenASIN[a]=true;});
      if(!fresh.length){fsConsecutive++;setTimeout(expandLoop,800);return;}

      // enrichBatch: content.js 一次性批量抓详情
      var batch=Math.min(fresh.length, fsTarget-fsProducts.length+20);
      chrome.tabs.sendMessage(fissionActiveTab,{action:'enrichBatch',asins:fresh.slice(0,batch)},function(result){
        if(!fsRunning) return;
        if(result&&result.success&&result.products){
          result.products.forEach(function(d){if(d&&d.title){fsProducts.push(d);fsConsecutive=0;}});
        }
        // 从新商品提取关键词
        fsProducts.slice(-5).forEach(function(p){
          extractKeywords(p).forEach(function(w){if(!fsUsedKws[w]){fsKws.push(w);}});
        });
        notifyPopup({type:'fission-progress',phase:'detail',msg:'已抓 '+fsProducts.length+'/'+fsTarget,pct:10+Math.round(Math.min(fsProducts.length/fsTarget,0.99)*88)});
        setTimeout(expandLoop,300);
      });
    });
  }

  function finishFission(){
    if(!fsRunning) return;
    clearTimeout(fsWatchdog);
    fsProducts.forEach(function(p){p.brand=(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();});
    notifyPopup({type:'fission-done',products:fsProducts,msg:'裂变完成: '+fsProducts.length+' 个商品'});
    fsRunning=false;
  }
}

var startFissionSeller = startFission;

// ============================================================
// 类目导出: 分批 enrichBatch, 每批完成后发进度
// ============================================================

function startExport(count, sender) {
  if (exportRunning) return;
  exportRunning = true; exportProducts = []; exportTotal = count;

  chrome.tabs.sendMessage(exportTab, { action: 'scrape' }, function(r) {
    if (!r || !r.success) { notifyPopup({ type: 'export-done', products: [], msg: 'Scrape failed' }); exportRunning = false; return; }
    var prods = (r.products || []).slice(0, Math.min(count, r.products.length));
    exportTotal = prods.length;
    if (!exportTotal) { notifyPopup({ type: 'export-done', products: [], msg: '0 products found' }); exportRunning = false; return; }
    notifyPopup({ type: 'export-progress', msg: 'Got ' + exportTotal + '. Enriching...', done: 0, total: exportTotal, pct: 5 });

    // 分批 enrichBatch: 每批 5 个 ASIN, 每批完成后发进度
    var batches = [];
    for (var i = 0; i < prods.length; i += 5) batches.push(prods.slice(i, Math.min(i + 5, prods.length)));

    function runBatch(bi) {
      if (!exportRunning || bi >= batches.length) {
        notifyPopup({ type: 'export-done', products: exportProducts, msg: 'Done! ' + exportProducts.length + ' products' });
        exportRunning = false; return;
      }
      var batch = batches[bi];
      var asins = batch.map(function(p) { return p.asin; });
      var pct = 5 + Math.round(bi / batches.length * 90);
      notifyPopup({ type: 'export-progress', msg: 'Enrich batch ' + (bi+1) + '/' + batches.length, done: exportProducts.length, total: exportTotal, pct: pct });

      chrome.tabs.sendMessage(exportTab, { action: 'enrichBatch', asins: asins }, function(result) {
        if (!exportRunning) return;
        if (result && result.success && result.products) {
          result.products.forEach(function(d, j) {
            var p = batch[j];
            exportProducts.push({
              asin: d.asin || p.asin, title: d.title || p.title || '',
              brand: d.brand || p.brand || '', link: 'https://www.amazon.com/dp/' + (d.asin || p.asin),
              image: d.image || p.image_url || '', price: d.price || p.price_usd || '',
              rating: d.rating || p.rating || '', reviews: d.reviews || p.review_count || 0,
              shipping: d.shipping || p._shipping || '',
              weight: d.weight || '', dims: d.dims || '',
              bsr: d.bsr || ((p.bsr || [])[0] ? ((p.bsr || [])[0].rank || '') : ''),
              monthly: d.monthly || p.monthly || ''
            });
          });
        } else {
          // fallback: shallow data
          batch.forEach(function(p) {
            exportProducts.push({ asin: p.asin, title: p.title||'', brand: p.brand||'', link: 'https://www.amazon.com/dp/'+p.asin, image: p.image_url||'', price: p.price_usd||'', rating: p.rating||'', reviews: p.review_count||0 });
          });
        }
        var pct2 = 5 + Math.round((bi+1) / batches.length * 90);
        notifyPopup({ type: 'export-progress', msg: 'Enriched ' + exportProducts.length + '/' + exportTotal, done: exportProducts.length, total: exportTotal, pct: pct2 });
        setTimeout(function() { runBatch(bi + 1); }, 300);
      });
    }
    runBatch(0);
  });
}

// ============================================================
// 公共工具
// ============================================================

function exA(h) {
  var a = [], seen = {};
  var re = /data-asin="([A-Z0-9]{10})"/g, m;
  while ((m = re.exec(h)) !== null) { if (!seen[m[1]]) { seen[m[1]] = true; a.push(m[1]); } }
  if (a.length < 3) {
    var re2 = /\/dp\/([A-Z0-9]{10})/g;
    while ((m = re2.exec(h)) !== null) { if (!seen[m[1]]) { seen[m[1]] = true; a.push(m[1]); } }
  }
  return a;
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
    .catch(function() { tryWIPO(cleanBrand, callback); });
}

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
