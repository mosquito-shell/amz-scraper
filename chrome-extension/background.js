/**
 * 后台 Service Worker — 商标查询 + 裂变搜索 + 代理
 */
'use strict';

var tmCache = {};
var fissionActiveTab = null;
var fissionRunning = false; // legacy compat (used by popup's own fissionRunning)

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
    fsRunning = false; fissionRunning = false;
    clearTimeout(fsWatchdog);
    sendResponse({ ok: true });
    return false;
  }
  if (request.action === 'getFissionState') {
    sendResponse({
      running: fsRunning || fissionRunning,
      enriched: fsProducts,
      done: fsProducts.length,
      total: fsTarget,
      queueSize: fsKws.length
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

// === 裂变搜索: 纯 SPA 关键词扩散 (稳定版) ===
var fsProducts=[], fsSeenASIN={}, fsTarget=0, fsRunning=false, fsKws=[], fsUsedKws={}, fsKi=0, fsConsecutive=0, fsWatchdog=null;

function startFission(seed, target, filters, sender){
  if(fsRunning)return;
  fsRunning=true;fsProducts=[];fsSeenASIN={};fsTarget=target;
  fsKws=[seed];fsUsedKws={};fsKi=0;fsConsecutive=0;

  notifyPopup({type:'fission-progress',phase:'search',msg:'种子: '+seed+' | 0/'+target,pct:2});

  fsWatchdog=setTimeout(function(){if(fsRunning)finishFission();},300000);

  // 延迟100ms确保popup listener已注册
  setTimeout(expandLoop, 200);

  function extractKeywords(p){
    var t=(p.title||'').toLowerCase();var b=(p.brand||'').toLowerCase().replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();
    var w=t.split(/[\s\/\-]+/).filter(function(w){return w.length>4&&!/^\d/.test(w);});
    if(b&&b.length>2&&b!=='generic')w.unshift(b);
    var s={},u=[];w.forEach(function(x){if(!s[x]){s[x]=true;u.push(x);}});
    return u;
  }

  function expandLoop(){
    if(!fsRunning||fsProducts.length>=fsTarget){finishFission();return;}
    if(fsConsecutive++>20){finishFission();return;}

    // 取下一个关键词
    if(fsKi>=fsKws.length){fsKi=0;}
    var kw=fsKws[fsKi++];
    if(!kw||fsUsedKws[kw]){setTimeout(expandLoop,200);return;}
    fsUsedKws[kw]=true;fsConsecutive=0;

    var url='https://www.amazon.com/s?k='+encodeURIComponent(kw);
    notifyPopup({type:'fission-progress',phase:'search',msg:'搜索: '+kw+' | '+fsProducts.length+'/'+fsTarget,pct:10+Math.round(fsProducts.length/fsTarget*20)});

    chrome.tabs.sendMessage(fissionActiveTab,{action:'fetchSearch',url:url},function(sr){
      if(!sr||!sr.success){fsConsecutive++;setTimeout(expandLoop,800);return;}
      var fresh=exA(sr.html).filter(function(a){return!fsSeenASIN[a];});
      fresh.forEach(function(a){fsSeenASIN[a]=true;});
      if(!fresh.length){fsConsecutive++;setTimeout(expandLoop,800);return;}

      var batch=Math.min(fresh.length,fsTarget-fsProducts.length+20);
      chrome.tabs.sendMessage(fissionActiveTab,{action:'enrichBatch',asins:fresh.slice(0,batch)},function(result){
        if(result&&result.success&&result.products){
          result.products.forEach(function(d){if(d&&d.title){fsProducts.push(d);fsConsecutive=0;}});
        }
        fsProducts.slice(-5).forEach(function(p){extractKeywords(p).forEach(function(w){if(!fsUsedKws[w]){fsKws.push(w);}});});
        notifyPopup({type:'fission-progress',phase:'detail',msg:'已抓 '+fsProducts.length+'/'+fsTarget,pct:10+Math.round(Math.min(fsProducts.length/fsTarget,0.99)*88)});
        setTimeout(expandLoop,300);
      });
    });
  }

  function finishFission(){
    if(!fsRunning)return;clearTimeout(fsWatchdog);
    fsProducts.forEach(function(p){p.brand=(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();});
    notifyPopup({type:'fission-done',products:fsProducts,msg:'裂变完成: '+fsProducts.length});
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
  exportRunning = true; exportProducts = []; exportTotal = count; exportDone = 0;

  chrome.tabs.sendMessage(exportTab, { action: 'scrape' }, function(r) {
    if (!r || !r.success) { notifyPopup({ type: 'export-progress', msg: 'Failed to scrape', done: 0, total: 0, pct: 0 }); exportRunning = false; return; }
    var prods = (r.products || []).slice(0, Math.min(count, r.products.length));
    exportTotal = prods.length;
    if (!exportTotal) { notifyPopup({ type: 'export-done', products: [], msg: '0 products found' }); exportRunning = false; return; }
    notifyPopup({ type: 'export-progress', msg: 'Got ' + exportTotal + '. Enriching...', done: 0, total: exportTotal, pct: 5 });

    // enrichBatch: content.js 一次性批量抓取所有 ASIN 详情, 不依赖后台多次 sendMessage 往返
    var asins = prods.map(function(p) { return p.asin; });
    chrome.tabs.sendMessage(exportTab, { action: 'enrichBatch', asins: asins }, function(result) {
      if (!result || !result.success) {
        // fallback: 返回浅层数据
        exportProducts = prods.map(function(p) { return { asin: p.asin, title: p.title||'', brand: p.brand||'', link: 'https://www.amazon.com/dp/'+p.asin, image: p.image_url||'', price: p.price_usd||'', rating: p.rating||'', reviews: p.review_count||0, shipping: p._shipping||'' }; });
      } else {
        exportProducts = (result.products || []).map(function(d, i) {
          return {
            asin: d.asin || prods[i].asin, title: d.title || prods[i].title || '',
            brand: d.brand || prods[i].brand || '', link: 'https://www.amazon.com/dp/' + (d.asin || prods[i].asin),
            image: d.image || prods[i].image_url || '', price: d.price || prods[i].price_usd || '',
            rating: d.rating || prods[i].rating || '', reviews: d.reviews || prods[i].review_count || 0,
            shipping: d.shipping || prods[i]._shipping || '',
            weight: d.weight || '', dims: d.dims || '',
            bsr: d.bsr || ((prods[i].bsr || [])[0] ? ((prods[i].bsr || [])[0].rank || '') : ''),
            monthly: d.monthly || prods[i].monthly || ''
          };
        });
      }
      notifyPopup({ type: 'export-done', products: exportProducts, msg: 'Done! ' + exportProducts.length + ' products' });
      exportRunning = false;
    });
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
