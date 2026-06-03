/**
 * Amazon 选品助手 Content Script vFinal
 */
(function() {
  'use strict';
  function clean(s) { return (s||'').replace(/\s+/g,' ').trim(); }

  function extract() {
    var products = [], seen = {};
    if (location.href.indexOf('/dp/') > -1) {
      var title = clean((document.getElementById('productTitle')||{}).textContent||'');
      var brand = clean((document.getElementById('bylineInfo')||{}).textContent||'').replace(/^(Visit the |Brand: )/,'').replace(/ Store$/,'');
      var price = parseFloat(((document.querySelector('.a-price .a-offscreen')||{}).textContent||'').match(/\$?(\d+\.?\d{0,2})/)||[0])||null;
      return [{ asin:(location.href.match(/\/dp\/([A-Z0-9]{10})/)||[])[1]||'', title:title, brand:brand, price_usd:price }];
    }

    var items = document.querySelectorAll('[data-asin]');
    if (!items.length) items = document.querySelectorAll('[data-component-type="s-search-result"]');
    if (!items.length) items = document.querySelectorAll('.s-result-item');

    items.forEach(function(card) {
      var asin = card.getAttribute('data-asin');
      if (!asin || asin.length !== 10 || seen[asin]) return;
      seen[asin] = true;
      var p = { asin: asin };
      var h2 = card.querySelector('h2');
      p.title = clean(h2 ? h2.textContent : '');
      if (!p.title) { var aria = card.querySelector('[aria-label]'); if (aria) p.title = clean(aria.getAttribute('aria-label')); }
      if (!p.title) {
        var spans = card.querySelectorAll('span'); var best = '';
        spans.forEach(function(s) { var t = clean(s.textContent); if (t.length > 15 && t.length < 250 && t.length > best.length && t.indexOf('out of') === -1 && !/^\$?\d/.test(t)) { best = t; p.title = t; } });
      }
      var sImg = card.querySelector('img.s-image');
      if (sImg) { p.image_url = sImg.getAttribute('src') || ''; }
      if (!p.image_url) {
        var imgs = card.querySelectorAll('img');
        for (var i = 0; i < imgs.length && !p.image_url; i++) {
          var src = imgs[i].src || '';
          if (src.startsWith('http') && src.indexOf('sprite')===-1 && src.indexOf('pixel')===-1 && src.indexOf('nav-')===-1 && src.indexOf('icon')===-1 && src.indexOf('logo')===-1 && src.indexOf('transparent')===-1) {
            p.image_url = imgs[i].getAttribute('data-old-hires') || (imgs[i].srcset ? imgs[i].srcset.split(',').pop().trim().split(' ')[0] : src);
          }
        }
      }
      // Brand
      var storeLink = card.querySelector('a[href*="/stores/"], a[href*="me="]');
      if (storeLink) p.brand = clean(storeLink.textContent);
      if (!p.brand) {
        var bylineSpans = card.querySelectorAll('span.a-size-base-plus, span.a-color-secondary, span.a-row.a-size-base');
        for (var j = 0; j < bylineSpans.length && !p.brand; j++) {
          var t = clean(bylineSpans[j].textContent);
          if (t && t.length > 1 && t.length < 40 && t !== 'Sponsored' && !/\$/.test(t)) p.brand = t;
        }
      }
      if (!p.brand && p.title) {
        var words = p.title.split(/\s+/);
        var first = words[0];
        if (first === first.toUpperCase() && first.length > 2 && first.length < 25 && !/^\d/.test(first)) p.brand = first;
      }
      var txt = card.textContent;
      var pm = txt.match(/\$(\d+\.?\d{0,2})/); if (pm) p.price_usd = parseFloat(pm[1]);
      var rm = txt.match(/(\d\.\d).*?(?:out of|stars)/i); if (rm) p.rating = parseFloat(rm[1]);
      // Reviews — 直接从 aria-label 属性提取(最准确)
      var allAria = card.querySelectorAll('[aria-label]');
      allAria.forEach(function(el) {
        if (p.review_count) return;
        var al = el.getAttribute('aria-label') || '';
        var m = al.match(/(\d[\d,]*)\s*ratings?/i);
        if (m) p.review_count = parseInt(m[1].replace(/,/g,''));
      });
      // Fallback 1: 卡片内纯数字 span (跟在评分后面)
      if (!p.review_count) {
        var allSpans = card.querySelectorAll('span');
        allSpans.forEach(function(s) {
          if (p.review_count) return;
          var st = (s.textContent||'').trim();
          if (/^\d[\d,]{0,8}$/.test(st) && !st.startsWith('$')) {
            var n = parseInt(st.replace(/,/g,''));
            if (n > 0 && n < 9999999) p.review_count = n;
          }
        });
      }
      // Fallback 2: 卡片全文匹配
      if (!p.review_count) {
        var m2 = txt.match(/(\d[\d,]*)\s*(?:ratings?|reviews?)/i);
        if (m2) p.review_count = parseInt(m2[1].replace(/,/g,''));
      }
      if (!p.review_count) p.review_count = 0;
      p.is_sponsored = txt.indexOf('Sponsored') > -1;
      p._official = false; var br = (p.brand||'').toLowerCase();
      if (br && ['amazon','amazon basics','echo','fire','kindle','ring','blink','eero'].some(function(o){return br.indexOf(o)===0||(p.title||'').toLowerCase().indexOf(o+' ')===0;})) p._official = true;
      var mb = txt.match(/(\d+[Kk]?\+?)\s*bought/i); p.monthly = mb ? mb[1] : '';
      products.push(p);
    });
    return products;
  }

  // Global access for sidebar
  window.__amzProducts__ = extract;

  // Fetch detail page (browser cookies, no CF Worker needed)
  window.__amzFetchDetail__ = function(asin, callback) {
    fetch('https://www.amazon.com/dp/' + asin, { credentials: 'include', headers: { 'User-Agent': navigator.userAgent, 'Accept': 'text/html' } })
      .then(function(r) { return r.text(); })
      .then(function(html) {
        if (!html || html.length < 8000) { callback({ err: 'blocked' }); return; }
        var result = {};
        // Weight & Dimensions (same as before)
        var wm = html.match(/(?:Item )?Weight[^<]*<\/(?:span|td|th)[^>]*>\s*<[^>]*>\s*(\d+\.?\d*)\s*(pounds?|ounces?|kg|Pounds?|Ounces?|grams?|g)\b/i);
        if (!wm) wm = html.match(/(?:Item )?Weight[:\s]*\s*(\d+\.?\d*)\s*(pounds?|ounces?|kg|grams?|g)/i);
        if (wm) {
          var v = parseFloat(wm[1]), u = wm[2].toLowerCase();
          if (/ounce/.test(u)) v = +(v / 35.274).toFixed(2);
          else if (/pound/.test(u)) v = +(v / 2.205).toFixed(2);
          else if (/gram/.test(u) && !/kg/.test(u)) v = +(v / 1000).toFixed(3);
          result.weight = v + ' kg';
        }
        var dm = html.match(/(?:Product )?Dimensions[^<]*<\/(?:span|td|th)[^>]*>\s*<[^>]*>\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*(inches?|cm|in)?/i);
        if (!dm) dm = html.match(/(?:Product )?Dimensions[:\s]*\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*x\s*(\d+\.?\d*)\s*(inches?|cm|in)?/i);
        if (dm) {
          var l = parseFloat(dm[1]), w = parseFloat(dm[2]), h = parseFloat(dm[3]);
          var du = (dm[4] || '').toLowerCase();
          // Convert inches → cm
          if (du.indexOf('in') >= 0) { l = Math.round(l * 2.54 * 10) / 10; w = Math.round(w * 2.54 * 10) / 10; h = Math.round(h * 2.54 * 10) / 10; }
          result.dimensions_cm = { length: l, width: w, height: h };
        }
        // Hi-res image
        var hires = html.match(/"hiRes"\s*:\s*"([^"]+)"/);
        if (hires) result.image_url = hires[1];
        else { var li = html.match(/id="landingImage"[^>]*src="([^"]+)"/); if (li) result.image_url = li[1]; }
        // BSR + Category full path
        var bsrSec = html.match(/Best Sellers Rank[\s\S]{0,500}?<\/tr>|<th[^>]*>Best Sellers Rank[\s\S]{0,500}?<\/td>/i);
        if (bsrSec) {
          var ranks = bsrSec[0].match(/#(\d[\d,]*)\s*(?:in\s*)?([^<#]+)/gi) || [];
          var bsrList = [];
          ranks.forEach(function(r) {
            var rm = r.match(/#(\d[\d,]*)\s*(?:in\s*)?(.+)/i);
            if (rm) bsrList.push({ rank: rm[1], category: (rm[2]||'').trim().replace(/&amp;/g,'&') });
          });
          if (bsrList.length) result.bsr = bsrList;
        }
        // Date First Available
        var dfa = html.match(/Date First Available[^<]*<\/(?:span|td|th)[^>]*>\s*<[^>]*>\s*([^<]+)/i);
        if (!dfa) dfa = html.match(/Date First Available[:\s]*\s*([^<\n]+)/i);
        if (dfa) result.date_first_available = dfa[1].trim();
        // ASIN / Model
        var model = html.match(/Item model number[^<]*<\/(?:span|td|th)[^>]*>\s*<[^>]*>\s*([^<]+)/i);
        if (model) result.model_number = model[1].trim();
        // Compare with similar items (竞品ASINs)
        var comp = html.match(/Compare with similar items[\s\S]{0,3000}?<\/div>/i);
        if (comp) {
          var compAsins = comp[0].match(/\/dp\/([A-Z0-9]{10})/g) || [];
          result.competitor_asins = compAsins.map(function(a) { return a.split('/').pop(); }).filter(function(a,i,arr){return arr.indexOf(a)===i;}).slice(0,10);
        }
        callback(result);
      })
      .catch(function(e) { callback({ err: e.message }); });
  };

  // Message handler
  chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.action === 'scrape') {
      try {
        var prods = extract();
        sendResponse({ success: true, products: prods, count: prods.length });
      } catch(e) {
        sendResponse({ success: false, error: e.message });
      }
    }
    if (request.action === 'getDetail') {
      if (window.__amzFetchDetail__) {
        window.__amzFetchDetail__(request.asin, function(d) { sendResponse(d || {}); });
        return true;
      }
      sendResponse({});
    }
    if (request.action === 'fetchSearch') {
      fetch(request.url, { credentials: 'include', headers: { 'User-Agent': navigator.userAgent, 'Accept': 'text/html' } })
        .then(function(r) { return r.text(); })
        .then(function(html) { sendResponse({ success: true, html: html }); })
        .catch(function(e) { sendResponse({ success: false, error: e.message }); });
      return true;
    }
    return true;
  });
})();
