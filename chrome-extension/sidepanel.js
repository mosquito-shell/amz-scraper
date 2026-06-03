/**
 * Amazon side panel - uses browser cookies to fetch details (bypass CF Worker)
 */
(function(){'use strict';
var allProducts=[],filteredProducts=[],scored=false,dragSrcRow=null,visible=false;
var productTags={},productNotes={};
try{productTags=JSON.parse(localStorage.getItem('amz_product_tags')||'{}');}catch(e){}
try{productNotes=JSON.parse(localStorage.getItem('amz_product_notes')||'{}');}catch(e){}

var TMBuiltin={};
(function(){var s='yonex anker wilson baden eastpoint senston hiraliy vevor boulder franklin keehoo eagles abovegenius zdgao phiniix bheop haokelball wettarn meooeck aoneky nike adidas lululemon heynuts sunzel colorfulkoala automet iuga swarovski pandora pavoi dearmay gokeey fancime beriso apple samsung sony bose jbl levi hanes gildan champion puma reebok asics mizuno fila head prince dunlop carlton victor lining spalding rawlings easton mikasa speedo arena coleman columbia salomon merrell keen teva crocs levis lee wrangler carhartt dickies guess fossil timex casio lacoste jansport herschel osprey thule yeti contigo nalgene stanley thermos swell bic pilot pentel zebra lego mattel hasbro nerf barbie disney marvel pokemon nintendo oakley rayban dyson shark hoover patagonia';s.split(' ').forEach(function(b){TMBuiltin[b]='1';});['franklin sports','triumph sports','eastpoint sports','park & sun sports','outdoor games','joy spot!','peak fits','the gym people','crz yoga','90 degree by reflex','leggings depot','kendra scott','amazon basics','fruit of the loom','under armour','new balance','north face','calvin klein','tommy hilfiger','ralph lauren','michael kors','kate spade','tory burch','vera bradley','hydro flask','tag heuer','star wars','fisher-price','uni-ball','helly hansen','dr martens','ozark trail','birkenstock','timberland','wolverine','seiko','citizen','tissot','rolex','omega','cartier','tiffany','underarmour','google','microsoft','lg','marmot','kelty','3m','scotch','duck','gorilla','elmers','whirlpool','ge','bissell','camelbak','swell','bubba','owala','sharpie','oceanic','cressi','tyr','finis','tachikara','colorfulkoala','eastpoint sports'].forEach(function(b){TMBuiltin[b]='1';});})();
function lookupTM(brand){if(!brand)return'0';var k=brand.toLowerCase().trim();if(k==='generic'||k==='from the author'||k==='n/a')return'0';if(TMBuiltin[k])return'1';return'?';}
var tmCache={};try{tmCache=JSON.parse(localStorage.getItem('amz_tm_cache')||'{}');}catch(e){}

function doTrademark(){
  var unknown=allProducts.filter(function(p){return p._tm==='?'||p._tm===undefined;});
  if(!unknown.length){alert('所有品牌已知');return;}
  var brands=[];var seen={};
  unknown.forEach(function(p){var b=(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').toLowerCase().trim();if(b&&!seen[b]){seen[b]=true;brands.push(p.brand);}});
  if(!brands.length){alert('无有效品牌');return;}
  chrome.runtime.sendMessage({action:'checkTrademarksBatch',brands:brands},function(results){
    if(results){Object.keys(results).forEach(function(brand){
      var k=brand.replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').toLowerCase().trim();
      if(k&&results[brand]&&results[brand].registered!==undefined){tmCache[k]=results[brand].registered?1:0;localStorage.setItem('amz_tm_cache',JSON.stringify(tmCache));}
    });}
    allProducts.forEach(function(p){var k=(p.brand||'').toLowerCase().trim();if(tmCache[k]!==undefined)p._tm=tmCache[k]?'1':'0';else p._tm=lookupTM(p.brand);});
    scoreAll(allProducts);applyFilter();renderTable();
  });
}

var W={price:20,demand:25,competition:20,brand:15,safety:10,social:10};
function sPrice(p){if(!p)return 50;if(p<6)return 15;if(p<12)return 60;if(p<=25)return 95;if(p<=40)return 85;if(p<=70)return 60;if(p<=120)return 40;return 15;}
function sDemand(bsr,mo){if(Array.isArray(bsr)&&bsr.length)bsr=parseInt(String(bsr[0].rank||'').replace(/,/g,''));if(!bsr||isNaN(bsr)){var n=parseInt(String(mo||'').replace(/[+K]/g,'').replace('K','000'));return isNaN(n)?30:(n>=5000?90:n>=1000?75:n>=500?60:n>=100?40:25);}return bsr<500?98:bsr<2000?90:bsr<5000?80:bsr<10000?65:bsr<30000?45:bsr<50000?30:bsr<100000?15:5;}
function sComp(r){return!r?50:r<30?90:r<100?85:r<500?80:r<2000?60:r<5000?40:r<15000?20:5;}
function sBrand(b,tm){if(!b||b==='Generic')return 30;return(tm==='0'||tm==='?')?90:(tm==='1'?30:70);}
function sSafe(p){var s=50;if(!p.is_sponsored)s+=25;if(p.brand&&p.brand!=='Generic')s+=15;var t=p._tm||'?';if(t==='0'||t==='?')s+=10;if(t==='1')s-=10;return Math.max(0,Math.min(100,s));}
function sSocial(r,c){if(!r)return 40;var s=r*15;if(c>100)s+=10;if(c>1000)s+=10;return Math.min(100,s);}
function scoreOne(p){var d={};d.price=sPrice(p.price_usd);d.demand=sDemand(p.bsr,p.monthly);d.competition=sComp(p.review_count);d.brand=sBrand(p.brand,p._tm);d.safety=sSafe(p);d.social=sSocial(p.rating,p.review_count);var t=0;for(var k in d)t+=d[k]*W[k]/100;p._score=Math.round(t*10)/10;p._details=d;return p;}
function scoreAll(l){l.forEach(scoreOne);l.sort(function(a,b){return(b._score||0)-(a._score||0)});return l;}

// ====== UI ======
var panel=document.createElement('div'),minimized=false;
panel.innerHTML='<div style="height:100%;display:flex;flex-direction:column;font:12px Arial,sans-serif">'+
'<div style="background:#131921;color:#fff;padding:8px 12px;display:flex;gap:8px;align-items:center">'+
'<b style="font-size:12px">选品</b><span id="sp-status" style="font-size:10px;opacity:.6">0件</span>'+
'<button id="sp-scrape" style="background:#ff9900;color:#000;border:none;border-radius:3px;padding:2px 8px;font-size:10px;font-weight:bold;cursor:pointer">抓取</button>'+
'<button id="sp-filter-toggle" style="background:#37475a;color:#fff;border:none;border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer">筛选</button>'+
'<button id="sp-enrich" style="background:#fff;color:#333;border:none;border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer">补详情</button>'+
'<button id="sp-trademark" style="background:#722ed1;color:#fff;border:none;border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer" title="查商标USPTO+WIPO">查商标</button>'+
'<button id="sp-exp" style="background:#28a745;color:#fff;border:none;border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer;margin-left:auto">导出</button>'+
'<button id="sp-close" style="background:none;border:none;color:#fff;font-size:14px;cursor:pointer;padding:0 4px">&times;</button></div>'+

// Filter bar (collapsible)
'<div id="sp-filter" style="background:#f0f2f5;border-bottom:1px solid #ddd;padding:6px 10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:10px">'+
'价格<input id="sf-pmin" value="" placeholder="min" style="width:45px;font-size:10px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px">-<input id="sf-pmax" value="" placeholder="max" style="width:45px;font-size:10px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px">'+
'BSR<<input id="sf-bsr" value="" placeholder="5000" style="width:50px;font-size:10px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px">'+
'评论>'+
'<input id="sf-revmin" value="" placeholder="min" style="width:40px;font-size:10px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px">-<input id="sf-revmax" value="" placeholder="max" style="width:45px;font-size:10px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px">'+
'月销>'+
'<input id="sf-sales" value="" placeholder="100" style="width:40px;font-size:10px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px">'+
'商标<select id="sf-tm" style="font-size:10px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px;width:55px"><option value="">不限</option><option value="1">已注册</option><option value="0">未注册</option><option value="?">待查</option></select>'+
'配送<select id="sf-ship" style="font-size:10px;padding:2px 4px;border:1px solid #d9d9d9;border-radius:3px;width:50px"><option value="">不限</option><option value="FBA">FBA</option><option value="MFN">MFN</option></select>'+
'<label style="font-size:9px;display:flex;align-items:center;gap:2px"><input type="checkbox" id="sf-noad" checked style="width:12px;height:12px">排广告</label>'+
'<button id="sf-reset" style="font-size:9px;padding:2px 6px;border:1px solid #d9d9d9;border-radius:3px;background:#fff;cursor:pointer">重置</button>'+
'<span style="font-size:9px;color:#888;margin-left:auto" id="sp-filter-count">0件</span>'+
'</div>'+

'<div id="sp-body" style="flex:1;overflow:auto;background:#fff"><table id="sp-table" style="width:100%;border-collapse:collapse;font-size:10px">'+
'<thead><tr style="background:#f5f5f5;position:sticky;top:0"><th>图</th><th>ASIN</th><th>标题</th><th>品牌</th><th>价格</th><th>评分</th><th>评论</th><th>商标</th><th>分数</th><th>体积</th><th>重量</th></tr></thead>'+
'<tbody id="sp-tbody"><tr><td colspan="11" style="text-align:center;padding:30px;color:#bbb">加载中...</td></tbody></table></div></div>';

panel.style.cssText='position:fixed;top:0;right:0;width:520px;height:100vh;z-index:2147483646;box-shadow:-2px 0 10px rgba(0,0,0,.2);display:flex;flex-direction:column';
document.body.appendChild(panel);

var collapseBtn=document.createElement('div');
collapseBtn.style.cssText='position:fixed;right:0;top:50%;width:24px;height:60px;background:#131921;color:#fff;z-index:2147483645;border-radius:8px 0 0 8px;display:flex;align-items:center;justify-content:center;font-size:11px;cursor:pointer;writing-mode:vertical-lr';
collapseBtn.textContent='选品';collapseBtn.onclick=function(){panel.style.display='flex';visible=true;};
document.body.appendChild(collapseBtn);

// ====== Scrape ======
function doScrape(){
  var btn=panel.querySelector('#sp-scrape');btn.textContent='...';btn.disabled=true;
  panel.querySelector('#sp-tbody').innerHTML='<tr><td colspan="11" style="text-align:center;padding:20px;color:#888">扫描中...</td></tr>';
  setTimeout(function(){
    try{
      var products=window.__amzProducts__?window.__amzProducts__():[];
      btn.textContent='刷新';btn.disabled=false;
      if(!products||!products.length){panel.querySelector('#sp-tbody').innerHTML='<tr><td colspan="11" style="text-align:center;padding:30px;color:red">未找到商品。请确认在Amazon搜索页。</td></tr>';return;}
      allProducts=products.map(function(p){return JSON.parse(JSON.stringify(p))});
      allProducts.forEach(function(p){p._tm=lookupTM(p.brand);p._official=false;});
      applyFilter();scoreAll(filteredProducts);
      panel.querySelector('#sp-status').textContent='已抓'+allProducts.length;
      renderTable();
    }catch(e){btn.textContent='重试';btn.disabled=false;}
  },300);
}

function renderTable(){
  var tb=panel.querySelector('#sp-tbody');tb.innerHTML='';
  filteredProducts.forEach(function(p){
    var s=p._score||0,bg=s>=70?'#d4edda':(s>=50?'#fffbe6':(s<30?'#f8d7da':''));
    var img=p.image_url||'';if(img.startsWith('//'))img='https:'+img;
    var tm=p._tm||'?',tc=tm==='1'?'color:#cf1322':(tm==='0'?'color:#389e0d':'color:#d48806');
    var dims=p.dimensions_cm?Math.round(p.dimensions_cm.length)+'x'+Math.round(p.dimensions_cm.width)+'x'+Math.round(p.dimensions_cm.height):'-';
    var rv=p.review_count||0;
    var tr=document.createElement('tr');tr.style.cssText='background:'+bg+';border-bottom:1px solid #f0f0f0';
    tr.innerHTML='<td style="padding:3px">'+(img?'<img src="'+img+'" width="35" height="35">':'')+'</td>'+
      '<td style="font-size:9px;padding:3px">'+p.asin+'</td>'+
      '<td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px" title="'+(p.title||'').replace(/"/g,'&quot;')+'">'+(p.title||'')+'</td>'+
      '<td style="font-size:10px;padding:3px">'+(p.brand||'--')+'</td>'+
      '<td style="padding:3px">'+(p.price_usd?'$'+p.price_usd:'--')+'</td>'+
      '<td style="padding:3px">'+(p.rating||'')+'</td>'+
      '<td style="padding:3px;font-size:10px">'+(rv?rv.toLocaleString():'0')+'</td>'+
      '<td style="font-weight:bold;'+tc+';padding:3px">'+tm+'</td>'+
      '<td style="font-weight:bold;padding:3px">'+s+'</td>'+
      '<td style="font-size:9px;color:#888;padding:3px">'+dims+'</td>'+
      '<td style="font-size:9px;color:#888;padding:3px">'+(p.weight||'-')+'</td>';
    tb.appendChild(tr);
  });
}

// ====== Enrich - 使用浏览器 cookies 直接请求 Amazon 详情页 ======
var enrichRunning=false,enrichDone=0,enrichTotal=0,enrichWeight=0,enrichDims=0;
function doEnrich(){
  if(enrichRunning){alert('正在补充详情中');return;}
  if(!filteredProducts.length){alert('无数据');return;}
  var todo=filteredProducts.filter(function(p){return !p.weight && !p.dimensions_cm;});
  if(!todo.length){alert('所有商品已有详情数据');return;}
  if(!confirm(todo.length+' 个商品需要补充详情(体积+重量)\n预估 '+(todo.length*3)+' 秒, 继续?')) return;

  enrichRunning=true;enrichDone=0;enrichTotal=todo.length;enrichWeight=0;enrichDims=0;
  var btn=panel.querySelector('#sp-enrich');btn.textContent='0/'+enrichTotal;btn.disabled=true;

  function next(){
    if(!enrichRunning||enrichDone>=enrichTotal){
      btn.textContent='补详情';btn.disabled=false;enrichRunning=false;renderTable();
      alert(enrichTotal+' 个完成!\n提取重量: '+enrichWeight+' 个\n提取体积: '+enrichDims+' 个');
      return;
    }
    var p=todo[enrichDone];
    if(window.__amzFetchDetail__){
      window.__amzFetchDetail__(p.asin,function(r){
        if(r&&!r.err){if(r.weight){p.weight=r.weight;enrichWeight++;}if(r.dimensions_cm){p.dimensions_cm=r.dimensions_cm;enrichDims++;}if(r.bsr){p.bsr=r.bsr;}if(r.date_first_available){p.date_first_available=r.date_first_available;}if(r.competitor_asins){p.competitor_asins=r.competitor_asins;}}
        enrichDone++;btn.textContent=enrichDone+'/'+enrichTotal+' ('+Math.round(enrichDone/enrichTotal*100)+'%)';
        renderTable();setTimeout(next,2000+Math.random()*1500);
      });
    } else {
      // Fallback: direct fetch
      fetch('https://www.amazon.com/dp/'+p.asin,{credentials:'include',headers:{'User-Agent':navigator.userAgent,'Accept':'text/html'}})
        .then(function(r){return r.text();}).then(function(html){
          if(html&&html.length>8000){
            var wm=html.match(/Weight[^>]*>\s*(\\d+\\.?\\d*)\\s*(pound|ounce|kg|gram|Pound|Ounce|g)/i);
            if(wm){var v=parseFloat(wm[1]),u=wm[2].toLowerCase();v=/ounce/.test(u)?+(v/35.3).toFixed(2):/pound/.test(u)?+(v/2.2).toFixed(2):/gram/.test(u)&&!/kg/.test(u)?+(v/1000).toFixed(3):v;p.weight=v+' kg';enrichWeight++;}
            var dm=html.match(/Dimensions[^>]*>\s*(\\d+\\.?\\d*)\\s*x\\s*(\\d+\\.?\\d*)\\s*x\\s*(\\d+\\.?\\d*)/i);
            if(dm){p.dimensions_cm={length:parseFloat(dm[1]),width:parseFloat(dm[2]),height:parseFloat(dm[3])};enrichDims++;}
          }
        }).catch(function(){}).finally(function(){
          enrichDone++;btn.textContent=enrichDone+'/'+enrichTotal;
          renderTable();setTimeout(next,2500);
        });
    }
  }
  next();
}

// ====== Filter ======
function applyFilter(){
  var pMin=parseFloat(document.getElementById('sf-pmin').value)||0;
  var pMax=parseFloat(document.getElementById('sf-pmax').value)||999;
  var bsrMax=parseInt(document.getElementById('sf-bsr').value)||999999;
  var revMin=parseInt(document.getElementById('sf-revmin').value)||0;
  var revMax=parseInt(document.getElementById('sf-revmax').value)||999999;
  var salesMin=parseInt(document.getElementById('sf-sales').value)||0;
  var tm=document.getElementById('sf-tm').value;
  var ship=document.getElementById('sf-ship').value;
  var noad=document.getElementById('sf-noad').checked;
  filteredProducts=allProducts.filter(function(p){
    var pr=p.price_usd||0;if(pr<pMin||pr>pMax)return false;
    var br=parseInt(String(((p.bsr||[])[0]||{}).rank||'999999').replace(/,/g,''));if(isNaN(br))br=999999;if(br>bsrMax)return false;
    var rv=p.review_count||0;if(rv<revMin||rv>revMax)return false;
    if(salesMin){var mb=parseInt(String(p.monthly||'').replace(/[+K]/g,'').replace('K','000'));if(isNaN(mb)||mb<salesMin)return false;}
    if(tm&&p._tm!==tm)return false;
    if(ship&&p._shipping!==ship)return false;
    if(noad&&p.is_sponsored)return false;
    return true;
  });
  scoreAll(filteredProducts);
  document.getElementById('sp-filter-count').textContent=filteredProducts.length+'件';
  document.getElementById('sp-status').textContent='已抓'+allProducts.length;
}

// ====== Export ======
function doExport(){
  var today=new Date().toISOString().slice(0,10),rows=[];
  rows.push('<tr><th>图片</th><th>ASIN</th><th>标题</th><th>品牌</th><th>售价(USD)</th><th>评分</th><th>评论数</th><th>BSR排名</th><th>品类</th><th>月销</th><th>配送</th><th>商标</th><th>体积(cm)</th><th>重量(kg)</th><th>上架日期</th><th>竞品ASIN</th><th>推荐分</th><th>推荐等级</th><th>广告</th><th>链接</th></tr>');
  filteredProducts.forEach(function(p){
    var img=p.image_url||'';if(img.startsWith('//'))img='https:'+img;
    var dims=p.dimensions_cm?Math.round(p.dimensions_cm.length)+'x'+Math.round(p.dimensions_cm.width)+'x'+Math.round(p.dimensions_cm.height):'';
    var bsrR=((p.bsr||[])[0]||{}).rank||'';
    var bsrC=((p.bsr||[])[0]||{}).category||'';
    var ship=p._shipping||'';
    var dfA=p.date_first_available||'';
    var comps=(p.competitor_asins||[]).slice(0,5).join(', ');
    var s=p._score||0;
    var rec=s>=80?'strong':(s>=70?'reco':(s>=60?'try':(s>=50?'warn':'no')));
    var ad=p.is_sponsored?'yes':'no';
    var imgCell=img?'<a href="'+img+'" target="_blank">pic</a>':'';
    rows.push('<tr><td>'+imgCell+'</td><td>'+p.asin+'</td><td>'+(p.title||'')+'</td><td>'+(p.brand||'')+'</td><td>'+(p.price_usd||'')+'</td><td>'+(p.rating||'')+'</td><td>'+((p.review_count||0).toLocaleString())+'</td><td>'+bsrR+'</td><td style="font-size:9px">'+bsrC+'</td><td>'+(p.monthly||'')+'</td><td>'+ship+'</td><td>'+(p._tm||'?')+'</td><td>'+dims+'</td><td>'+(p.weight||'')+'</td><td>'+dfA+'</td><td style="font-size:9px">'+comps+'</td><td>'+s+'</td><td>'+rec+'</td><td>'+ad+'</td><td><a href="https://www.amazon.com/dp/'+p.asin+'">link</a></td></tr>');
  });
  var html='<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>td{font-size:11px;border:1px solid #ccc;padding:3px 6px}th{background:#232f3e;color:#fff;font-size:11px;padding:6px 8px}</style></head><body><table border="1">'+rows.join('')+'</table></body></html>';
  var blob=new Blob([html],{type:'application/vnd.ms-excel'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='amz_'+today+'.xls';a.click();
}

// ====== Bindings ======
panel.querySelector('#sp-scrape').onclick=doScrape;
panel.querySelector('#sp-enrich').onclick=doEnrich;
panel.querySelector('#sp-trademark').onclick=doTrademark;
panel.querySelector('#sp-exp').onclick=doExport;
panel.querySelector('#sp-close').onclick=function(){panel.style.display='none';visible=false;};

// Filter toggle
panel.querySelector('#sp-filter-toggle').onclick=function(){
  var f=document.getElementById('sp-filter');
  f.style.display=f.style.display==='none'?'':'none';
};

// Filter inputs → re-filter on change
['sf-pmin','sf-pmax','sf-bsr','sf-revmin','sf-revmax','sf-sales','sf-tm','sf-ship'].forEach(function(id){
  var el=document.getElementById(id); if(el) el.onchange=function(){filterAfterInput();};
});
document.getElementById('sf-noad').onchange=function(){filterAfterInput();};
document.getElementById('sf-reset').onclick=function(){
  document.getElementById('sf-pmin').value='';document.getElementById('sf-pmax').value='';
  document.getElementById('sf-bsr').value='';document.getElementById('sf-revmin').value='';
  document.getElementById('sf-revmax').value='';document.getElementById('sf-sales').value='';
  document.getElementById('sf-tm').value='';document.getElementById('sf-ship').value='';
  document.getElementById('sf-noad').checked=true;
  applyFilter();renderTable();
};

function filterAfterInput(){
  applyFilter();renderTable();
}

setTimeout(function(){doScrape();},600);
})();
