(function(){'use strict';
var fissionRunning=false,fissionSeen={},fissionQueue=[],enriched=[],done=0,total=0,activeTabId=null;
chrome.tabs.query({active:true,currentWindow:true},function(tabs){if(tabs[0]){activeTabId=tabs[0].id;var el=document.getElementById('ex-url');if(el)el.value=tabs[0].url||'';}});
// === 数据持久化：工作台数据从 localStorage 恢复，每次采集累加 ===
var exProducts=[],fsProducts=[],dragSrc=null,wbTags={},wbNotes={},wbChecked={};
try{exProducts=JSON.parse(localStorage.getItem('amz_ex_products')||'[]');}catch(e){}
try{fsProducts=JSON.parse(localStorage.getItem('amz_fs_products')||'[]');}catch(e){}
try{wbTags=JSON.parse(localStorage.getItem('amz_product_tags')||'{}');}catch(e){}
try{wbNotes=JSON.parse(localStorage.getItem('amz_product_notes')||'{}');}catch(e){}
var W=JSON.parse(localStorage.getItem('amz_weights')||'{"price":20,"demand":25,"competition":20,"brand":15,"safety":10,"social":10}');
// Per-category weights (按品类分权重)
var CW=JSON.parse(localStorage.getItem('amz_cat_weights')||'{"default":{"price":20,"demand":25,"competition":20,"brand":15,"safety":10,"social":10}}');
var WH=JSON.parse(localStorage.getItem('amz_weights_history')||'[]');
var TM_CACHE={};try{TM_CACHE=JSON.parse(localStorage.getItem('amz_tm_cache')||'{}');}catch(e){}
// Upgrade old 0/1 cache entries to {v,expires} format
Object.keys(TM_CACHE).forEach(function(k){if(typeof TM_CACHE[k]!=='object'){TM_CACHE[k]={v:TM_CACHE[k]?1:0,ts:Date.now()-86400000,expires:Date.now()+315360000000};}});

// TM 10年TTL查询
function tmGet(b){var e=TM_CACHE[b];if(!e||typeof e!=='object')return null;if(Date.now()>e.expires){delete TM_CACHE[b];return null;}return e.v;}

function tmSet(brand,val){
  var k=(brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').toLowerCase().trim();
  TM_CACHE[k]={v:val?1:0,ts:Date.now(),expires:Date.now()+315360000000}; // 10年
  save();
}

// 库存监控 (PRD 算法2)
var STOCK_LOG={};try{STOCK_LOG=JSON.parse(localStorage.getItem('amz_stock_log')||'{}');}catch(e){}
function calcSalesByInventory(p){
  var log=STOCK_LOG[p.asin]||[];
  if(log.length<2)return null; // need 2+ samples
  log.sort(function(a,b){return b.ts-a.ts;});
  var latest=log[0],oldest=log[log.length-1];
  var days=(latest.ts-oldest.ts)/86400000;
  if(days<1)return null;
  var delta=Math.max(0,(oldest.stock||0)-(latest.stock||0));
  return Math.round(delta/days*30); // project to monthly
}
function logStock(asin,stock){if(!STOCK_LOG[asin])STOCK_LOG[asin]=[];STOCK_LOG[asin].push({ts:Date.now(),stock:stock||0});if(STOCK_LOG[asin].length>30)STOCK_LOG[asin]=STOCK_LOG[asin].slice(-30);localStorage.setItem('amz_stock_log',JSON.stringify(STOCK_LOG));}

// PRD 算法1: BSR排名 → 月销量推算
function bsrToMonthly(p){
  var r=parseInt(p.bsr||'0');if(!r||r<=0){var bsrArr=p.bsr;if(Array.isArray(bsrArr)&&bsrArr.length)r=parseInt(String(bsrArr[0].rank||'').replace(/,/g,''))||0;}
  if(!r||r<=0)return null;
  // 品类系数
  var t=(p.title||'').toLowerCase();var coeff=1.0;
  if(/clothing|shoes|jewelry|服饰|珠宝/i.test(t))coeff=1.3;
  if(/sports|outdoor|运动|户外/i.test(t))coeff=0.8;
  if(/electronic|kindle|phone|电子/i.test(t))coeff=0.6;
  var est=Math.round(coeff*1000000/Math.pow(r,0.9));
  if(isNaN(est))return null;
  return est>=1000?Math.round(est/100)*100:est>=100?Math.round(est/10)*10:est;
}

var API_BASE=localStorage.getItem('amz_api_base')||'https://api.tsscjn.top';

// === HS编码推荐引擎 (100+条目, 含美国进口关税) ===
var HS_DB=[
["racket","badminton","tennis","paddle","shuttlecock","9506.59","运动球拍/羽毛球",4.7],
["ball","soccer","basketball","football","volleyball","9506.62","可充气球类",3.0],
["glove","boxing","mma","martial","9511.20","拳击/格斗手套",3.8],
["yoga","legging","tights","pant","stretch","6112.49","瑜伽裤/紧身裤(化纤)",28.4],
["cotton","shirt","pant","jean","denim","6204.62","棉质长裤",16.6],
["jacket","coat","parka","hoodie","sweatshirt","6201.93","化纤外套/夹克",27.7],
["bra","underwear","brief","panty","boxer","6212.10","内衣/文胸",16.9],
["swim","bikini","swimwear","trunk","board","6211.11","泳装(男)",7.6],
["sock","stocking","hosiery","6115.96","袜类(化纤)",18.8],
["hat","cap","baseball","beanie","visor","6505.00","帽类",7.5],
["scarf","shawl","wrap","bandana","6214.10","围巾/披肩",8.4],
["glove","mitten","winter","thermal","6116.93","防寒手套",10.0],
["belt","buckle","leather","waist","4203.30","皮带(皮革)",8.0],
["bag","backpack","handbag","purse","tote","4202.22","手提包(化纤)",17.6],
["wallet","card","holder","purse","4202.31","钱包(皮革)",8.0],
["shoe","sneaker","boot","sandal","slipper","6404.19","运动鞋(纺织面)",20.0],
["watch","wristwatch","timepiece","chronograph","9102.11","电子手表",4.4],
["ring","pendant","necklace","chain","gold","7113.19","贵金属首饰",5.5],
["earring","stud","hoop","dangle","7113.19","耳环(贵金属)",5.5],
["bracelet","bangle","cuff","anklet","wrist","7117.90","仿首饰/手链",0.0],
["necklace","pendant","choker","locket","chain","7117.90","仿首饰/项链",0.0],
["phone","case","cover","iphone","samsung","4202.32","手机壳(化纤)",17.6],
["charger","usb","adapter","power","charging","8504.40","充电器/电源适配器",2.5],
["cable","cord","wire","lightning","micro","8544.42","USB数据线",2.6],
["speaker","bluetooth","audio","sound","woofer","8518.22","蓝牙音箱",4.9],
["headphone","earphone","earbud","headset","airpods","8518.30","耳机",4.9],
["keyboard","mouse","mechanical","gaming","8471.60","键盘/鼠标",0.0],
["monitor","screen","display","lcd","led","8528.52","显示器",0.0],
["laptop","stand","cooling","pad","holder","8473.30","笔记本配件",0.0],
["battery","power","bank","cell","recharge","8507.60","锂电池/充电宝",3.4],
["lamp","light","bulb","led","flashlight","9405.40","LED灯具",5.3],
["mat","carpet","rug","floor","door","5703.30","地毯/地垫(化纤)",6.0],
["towel","towel","wash","beach","microfiber","6302.60","毛巾(棉)",9.1],
["blanket","throw","fleece","quilt","duvet","6301.40","毯子(化纤)",8.5],
["pillow","cushion","bolster","neck","9404.90","枕头/靠垫",6.0],
["curtain","drape","blind","shade","6303.92","窗帘(化纤)",11.4],
["kitchen","utensil","spatula","whisk","silicone","3924.10","厨房用具(塑料)",6.5],
["bottle","water","tumbler","vacuum","stainless","9617.00","保温杯/水瓶(不锈钢)",8.0],
["cup","mug","ceramic","coffee","tea","6912.00","陶瓷杯/餐具",6.0],
["storage","organizer","bin","basket","box","3924.90","收纳盒(塑料)",6.5],
["tool","drill","screwdriver","wrench","plier","8205.59","手动工具",3.7],
["tape","adhesive","duct","masking","glue","3919.10","胶带(塑料)",5.8],
["toy","figure","doll","action","plush","9503.00","玩具/玩偶",0.0],
["puzzle","board","game","card","chess","9504.90","棋盘游戏",0.0],
["pet","dog","cat","leash","collar","4201.00","宠物用品(皮革)",0.8],
["leash","harness","collar","dog","pet","4201.00","宠物牵引带",0.8],
["massage","gun","massager","fascia","percussion","9019.10","按摩器",1.4],
["vitamin","supplement","pill","capsule","mineral","2106.90","膳食补充剂",6.4],
["makeup","cosmetic","lipstick","mascara","brush","3304.20","眼妆化妆品",0.0],
["nail","polish","gel","manicure","acrylic","3304.30","指甲产品",0.0],
["hair","wig","extension","braid","clip","6704.11","假发/发片(化纤)",2.5],
["bike","cycling","bicycle","helmet","pedal","8712.00","自行车",11.0],
["skate","skateboard","longboard","roller","9506.70","滑板/轮滑鞋",0.0],
["tent","camping","sleeping","bag","hiking","6306.22","帐篷(化纤)",8.8],
["dumbbell","weight","kettlebell","barbell","plate","9506.91","哑铃/健身器械",3.0],
["resistance","band","tube","loop","pull","9506.91","弹力带/健身配件",3.0],
["jump","rope","skipping","speed","9506.91","跳绳",3.0],
["goggle","glasses","swim","dive","snorkel","9004.90","护目镜/游泳镜",2.5],
["sunglasses","eyewear","shades","9004.10","太阳镜",2.0],
["camera","dashcam","camcorder","gopro","8525.89","相机/摄像机",0.0],
["phone","smartphone","cell","mobile","8521.72","手机",0.0],
["case","cover","protector","shell","4202.32","保护壳(塑料/纺织)",17.6],
["screen","protector","tempered","film","glass","3920.69","屏幕保护膜(塑料)",5.8],
["drone","quadcopter","rc","helicopter","8526.92","无人机/航模",0.0],
["3d","printer","printing","filament","8477.59","3D打印机",3.1],
["printer","ink","toner","laser","8443.32","打印机/墨盒",0.0],
["measuring","tape","ruler","caliper","digital","9017.80","量具/尺子",2.3],
["scale","weight","digital","body","kitchen","8423.10","电子秤",1.6],
["lock","padlock","combination","smart","8301.10","挂锁",4.3],
["umbrella","rain","foldable","parasol","6601.91","雨伞",8.0],
["scissors","shear","cutter","craft","8213.00","剪刀",2.7],
["knife","pocket","folding","blade","kitchen","8211.92","刀具(固定刀片)",3.9],
["bedding","sheet","fitted","pillowcase","set","6302.31","床单(棉)",6.7],
["comforter","duvet","down","quilt","insert","9404.40","羽绒被",12.4],
["frame","picture","photo","wall","collage","4414.00","木质相框",3.9],
["clock","alarm","wall","desk","digital","9105.91","电子时钟",4.3],
["sticker","decal","label","vinyl","wall","3919.90","贴纸(塑料)",5.8],
["party","decoration","balloon","banner","confetti","9505.90","派对装饰品",0.0],
["christmas","tree","ornament","light","decoration","9505.10","圣诞装饰品",0.0],
["mask","face","sleep","eye","costume","6307.90","睡眠眼罩/面罩",7.0],
["costume","cosplay","halloween","dress","6104.43","化纤连衣裙",16.0],
["baby","toy","teether","rattle","pacifier","9503.00","婴儿玩具",0.0],
["lunch","box","container","bento","food","3924.10","午餐盒(塑料)",6.5],
["cookware","pot","pan","fry","nonstick","7323.93","炊具(不锈钢)",3.4],
["cutting","board","chopping","bamboo","plastic","3924.10","砧板(塑料)",6.5],
["car","auto","accessory","air","fresh","8708.99","汽车配件/装饰件",2.5],
["phone","mount","holder","car","dash","3926.90","车载手机支架",5.3],
["patch","iron","embroidered","sew","badge","5810.92","刺绣贴片",7.3],
["yarn","thread","crochet","knitting","wool","5207.10","纱线(棉)",5.0],
["craft","kit","diy","bead","bracelet","3926.10","手工艺套装(塑料)",5.3],
["artificial","plant","flower","fake","faux","6702.10","人造花/植物",8.4],
["sportswear","active","shirt","top","tank","6109.90","运动T恤(化纤)",32.0],
["short","shorts","cargo","athletic","6203.43","化纤短裤(男)",27.9],
["sleepwear","pajama","lounge","robe","6208.22","睡衣/家居服(化纤)",16.0],
["knee","elbow","brace","support","sleeve","9021.10","护具/矫形器",0.0],
["tape","kinesiology","athletic","sport","medical","3005.10","运动胶带/创可贴",0.0],
["lens","contact","camera","phone","9001.30","隐形眼镜",2.0]
];

var wbHS={};try{wbHS=JSON.parse(localStorage.getItem('amz_hs_codes')||'{}');}catch(e){}

function hsGuess(title,brand){
  var t=(title||'').toLowerCase(),b=(brand||'').toLowerCase();
  var tWords=t.split(/[\s\/\-()]+/).filter(function(w){return w.length>2;});
  var best=null,bestScore=0;
  // Add full title as extra "keyword" for phrase matching
  tWords.push(t.substr(0,40));
  HS_DB.forEach(function(row){
    var score=0;
    for(var i=0;i<5;i++){if(row[i]&&row[i].length>1&&t.indexOf(row[i])>=0)score+=15;}
    tWords.forEach(function(w){for(var j=0;j<5;j++){if(row[j]===w)score+=25;}});
    if(t.indexOf(row[5])>=0)score+=30;
    if(score>bestScore){bestScore=score;best=row;}
  });
  if(best&&bestScore>=15)return{code:best[5],name:best[6],tariff:best[7]};
  return{code:'6117.90',name:'通用纺织品/杂项',tariff:7.5};
}

function hsFor(p){if(wbHS[p.asin])return wbHS[p.asin];
  // G: 字段修正建议 — 同品牌优先复用历史手动编辑的HS
  var bk=(p.brand||'').toLowerCase().trim();var best=null;
  Object.keys(wbHS).forEach(function(a){var h=wbHS[a];if(h&&h._manual&&h._brand===bk){best=h;}});
  if(best)return best;
  var h=hsGuess(p.title,p.brand);wbHS[p.asin]=h;return h;
}
// G: 字段修正历史
var FIELD_CORRECTIONS={};try{FIELD_CORRECTIONS=JSON.parse(localStorage.getItem('amz_field_corrections')||'{}');}catch(e){}
function suggestField(p,field){
  var bk=(p.brand||'').toLowerCase().trim();var cat=p._cat||catFor(p);
  var history=FIELD_CORRECTIONS[bk]||{};if(history[field])return history[field];
  history=FIELD_CORRECTIONS[cat]||{};if(history[field])return history[field];
  return null;
}
function saveCorrection(brand,field,value){
  var bk=(brand||'').toLowerCase().trim();if(!bk||!value)return;
  if(!FIELD_CORRECTIONS[bk])FIELD_CORRECTIONS[bk]={};
  FIELD_CORRECTIONS[bk][field]=value;
  localStorage.setItem('amz_field_corrections',JSON.stringify(FIELD_CORRECTIONS));
}
function hsSave(){localStorage.setItem('amz_hs_codes',JSON.stringify(wbHS));}
function save(){localStorage.setItem('amz_product_tags',JSON.stringify(wbTags));localStorage.setItem('amz_product_notes',JSON.stringify(wbNotes));localStorage.setItem('amz_weights',JSON.stringify(W));localStorage.setItem('amz_cat_weights',JSON.stringify(CW));localStorage.setItem('amz_weights_history',JSON.stringify(WH));localStorage.setItem('amz_tm_cache',JSON.stringify(TM_CACHE));localStorage.setItem('amz_ex_products',JSON.stringify(exProducts));localStorage.setItem('amz_fs_products',JSON.stringify(fsProducts));hsSave();}

// === 数据累加/去重/删除 ===
function mergeProducts(target,sauce){var seen={};target.forEach(function(x){seen[x.asin]=true;});var added=0;sauce.forEach(function(x){if(!seen[x.asin]){seen[x.asin]=true;target.push(x);added++;}});return added;}
function deleteProduct(list,asin,prefix){for(var i=list.length-1;i>=0;i--){if(list[i].asin===asin){list.splice(i,1);break;}}save();rWB(list,prefix+'-wb-table',prefix+'-wb-count',prefix);}
function clearProducts(list,prefix){list.length=0;save();rWB(list,prefix+'-wb-table',prefix+'-wb-count',prefix);document.getElementById(prefix+'-workbench').style.display='none';}
function selectAllWB(pfx){var prods=pfx==='ex'?exProducts:fsProducts;prods.forEach(function(p){wbChecked[p.asin]=true;});rWB(prods,pfx+'-wb-table',pfx+'-wb-count',pfx);}
function restoreWorkbench(prefix){var list=prefix==='ex'?exProducts:fsProducts;if(list.length){document.getElementById(prefix+'-workbench').style.display='';rWB(list,prefix+'-wb-table',prefix+'-wb-count',prefix);}}

// Category detection → per-category weight lookup
var CAT_MAP={9506: '运动户外',9505: '运动户外',6112: '服装纺织',6204: '服装纺织',6203: '服装纺织',6201: '服装纺织',6211: '服装纺织',6212: '服装纺织',6109: '服装纺织',6115: '服装纺织',6505: '服装纺织',6214: '服装纺织',6404: '服装纺织',4202: '服装纺织',4203: '服装纺织',9102: '珠宝首饰',7113: '珠宝首饰',7117: '珠宝首饰',9004: '珠宝首饰',8504: '电子配件',8518: '电子配件',8471: '电子配件',8528: '电子配件',8544: '电子配件',8507: '电子配件',8525: '电子配件',9405: '家居日用品',9404: '家居日用品',5703: '家居日用品',6302: '家居日用品',6301: '家居日用品',6912: '家居日用品',3924: '家居日用品',9617: '家居日用品',3926: '家居日用品',9503: '玩具',9504: '玩具',9019: '运动户外',8213: '家居日用品',3304: '美妆个护',2106: '美妆个护',8712: '运动户外',6306: '运动户外',9021: '运动户外',8205: '家居日用品',7323: '家居日用品',8708: '电子配件',4201: '家居日用品'};

function catFor(p){
  var hsc=hsFor(p);
  var code=hsc.code; var prefix=code.substring(0,4);
  if(CAT_MAP[code])return CAT_MAP[code];
  if(CAT_MAP[prefix])return CAT_MAP[prefix];
  var t=(p.title||'').toLowerCase();
  if(/racket|ball|yoga|swim|dumbbell|bike|skate|tent|camping|fitness|sport|exercise|running|hiking/i.test(t))return'运动户外';
  if(/shirt|pant|jacket|dress|bra|sock|hat|scarf|shoe|boot|belt|bag|backpack|underwear/i.test(t))return'服装纺织';
  if(/charger|cable|speaker|headphone|phone|battery|lamp|monitor|keyboard|mouse|camera/i.test(t))return'电子配件';
  if(/ring|necklace|bracelet|earring|pendant|watch|gold|silver|jewelry/i.test(t))return'珠宝首饰';
  if(/toy|doll|puzzle|game|lego|plush|figure|block/i.test(t))return'玩具';
  return'家居日用品';
}

function wFor(p){
  var cat=catFor(p);
  if(CW[cat])return CW[cat];
  return CW['default']||W;
}
var TM={yonex:1,anker:1,wilson:1,baden:1,eastpoint:1,senston:1,hiraliy:1,vevor:1,boulder:1,franklin:1,keehoo:1,eagles:1,abovegenius:1,zdgao:1,nike:1,adidas:1,lululemon:1,heynuts:1,sunzel:1,colorfulkoala:1,automet:1,iuga:1,swarovski:1,pandora:1,pavoi:1,dearmay:1,gokeey:1,fancime:1,beriso:1,apple:1,samsung:1,sony:1,bose:1,jbl:1,levi:1,hanes:1,gildan:1,champion:1,puma:1,reebok:1,asics:1,mizuno:1,fila:1,columbia:1,carhartt:1,dickies:1,timex:1,casio:1,lego:1,mattel:1,hasbro:1,nerf:1,disney:1,marvel:1,nintendo:1,phiniix:1,wettarn:1,meooeck:1,aoneky:1,haokelball:1,spalding:1,mikasa:1};
function tm(b){if(!b)return'0';var k=b.replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').toLowerCase().trim();if(k==='generic'||k==='from the author')return'0';var c=tmGet(k);if(c!==null)return c?'1':'0';if(TM[k]!==undefined)return TM[k]?'1':'0';return'?';}
function sc(p){var pr=parseFloat(p.price)||0,rv=parseInt(p.reviews)||0,rt=parseFloat(p.rating)||0,br=parseInt(p.bsr)||999999;var ps=pr<6?15:pr<12?60:pr<=25?95:pr<=40?85:pr<=70?60:pr<=120?40:15;var ds=br<500?98:br<2000?90:br<5000?80:br<10000?65:br<30000?45:br<50000?30:br<100000?15:5;var cs=rv<30?90:rv<100?85:rv<500?80:rv<2000?60:rv<5000?40:rv<15000?20:5;var t=tm(p.brand);var bs=(t==='0'||t==='?')?90:(t==='1'?30:70);var ss=rt?Math.min(100,rt*15+(rv>100?10:0)+(rv>1000?10:0)):40;var w=wFor(p);p._cat=catFor(p);p.score=Math.round((ps*(w.price||20)+ds*(w.demand||25)+cs*(w.competition||20)+bs*(w.brand||15)+ss*(w.safety||10)+ss*(w.social||10))/10)/10;p.tmSt=t;p.lv=p.score>=80?'强推':p.score>=70?'推荐':p.score>=60?'可试':p.score>=50?'谨慎':'不推';}
// === 启动时自动从后端拉取最新权重 + 商标共享缓存 ===
fetch(API_BASE+'/api/weights',{method:'GET'}).then(function(r){return r.json();}).then(function(d){
  if(d&&d.weights){W=d.weights;save();console.log('Weights loaded from backend');}
}).catch(function(){console.log('Weight sync skipped (backend unreachable)');});
fetch(API_BASE+'/api/tm-cache',{method:'GET'}).then(function(r){return r.json();}).then(function(d){
  if(d){Object.keys(d).forEach(function(k){TM_CACHE[k]=d[k];});save();console.log('TM cache loaded:',Object.keys(d).length,'brands');}
}).catch(function(){});
// Load proxy health
fetch(API_BASE+'/api/proxy-status',{method:'GET'}).then(function(r){return r.json();}).then(function(d){
  if(d&&d.proxies){var online=d.proxies.filter(function(p){return p.online;}).length;console.log('Proxies:',online+'/'+d.total,'online');}
}).catch(function(){});

// Tabs
document.querySelectorAll('.tab-btn').forEach(function(b){b.onclick=function(){var t=this.dataset.tab;document.querySelectorAll('.tab-btn').forEach(function(x){x.classList.remove('active')});this.classList.add('active');document.querySelectorAll('.panel').forEach(function(p){p.classList.remove('active')});var el=document.getElementById('p-'+t);if(el)el.classList.add('active');};});
// Download
function dl(data,pfx){data.sort(function(a,b){return(b.score||0)-(a.score||0)});var dt=new Date().toISOString().slice(0,10),r=[];r.push('<tr><th>分</th><th>ASIN</th><th>标题</th><th>图片URL</th><th>代理图片URL</th><th>品牌</th><th>价格</th><th>币种</th><th>体积</th><th>重量</th><th>BSR</th><th>评分</th><th>评论</th><th>月销</th><th>配送</th><th>HS编码</th><th>HS品名</th><th>关税%</th><th>链接</th></tr>');data.forEach(function(p){var hsc=hsFor(p);var b=p.bsr||'',d=p.dims||'',w=p.weight||'',i=p.image||'',br=(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();var proxyImgUrl=i?'https://proxy.tsscjn.top/?url='+encodeURIComponent(i):'';r.push('<tr><td style="font-weight:bold">'+(p.score||'')+'</td><td>'+p.asin+'</td><td>'+(p.title||'')+'</td><td><a href="'+i+'">图片</a></td><td>'+proxyImgUrl+'</td><td>'+br+'</td><td>'+(p.price||'')+'</td><td>USD</td><td>'+d+'</td><td>'+w+'</td><td>'+b+'</td><td>'+(p.rating||'')+'</td><td>'+(p.reviews||0)+'</td><td>'+(p.monthly||'')+'</td><td>'+(p.shipping||'')+'</td><td>'+hsc.code+'</td><td>'+hsc.name+'</td><td>'+hsc.tariff+'%</td><td>'+(p.link||'')+'</td></tr>');});var h='<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>td{font-size:11px;border:1px solid #ccc}th{background:#232f3e;color:#fff;font-size:11px}</style></head><body><table border="1">'+r.join('')+'</table></body></html>';var bl=new Blob([h],{type:'application/vnd.ms-excel'});var a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download=pfx+'_'+dt+'.xls';a.click();}
function sDL(id,data,pfx){data.sort(function(a,b){return(b.score||0)-(a.score||0)});var b=document.getElementById(id);if(!b){b=document.createElement('button');b.id=id;b.className='btn btn-blue btn-block';b.textContent='下载 Excel';document.getElementById(pfx==='export'?'p-export':'p-fission').appendChild(b);}b.style.display='block';b.onclick=function(){dl(data,pfx);};}
// Workbench
function rWB(prods,tid,cid,pfx){
  var tb=document.querySelector('#'+tid+' tbody');if(!tb)return;
  var pn=document.getElementById(pfx+'-workbench');if(pn)pn.style.display=prods.length?'':'none';
  tb.innerHTML='';prods.forEach(function(p){
    var ch=wbChecked[p.asin]===true?'checked':'';var tg=wbTags[p.asin]||'';var th='<span style="color:#ccc">--</span>';
    if(tg==='priority')th='<span style="color:#52c41a;font-weight:bold;font-size:14px">优</span>';
    else if(tg==='maybe')th='<span style="color:#fa8c16;font-size:14px">?</span>';
    else if(tg==='reject')th='<span style="color:#ff4d4f;font-weight:bold;font-size:14px">X</span>';
    var nt=(wbNotes[p.asin]||'').substr(0,10);var tmr=tm(p.brand);var tc=tmr==='1'?'color:#cf1322':(tmr==='0'?'color:#389e0d':'color:#d48806');
    var cl=(p.score||0)>=70?'background:#d4edda':((p.score||0)>=50?'background:#fffbe6':'background:#f8d7da');
    var img=p.image||'';if(img.startsWith('//'))img='https:'+img;var ic=img?'<img src="'+img+'" width="32" height="32" style="object-fit:contain;border-radius:3px" onerror="this.onerror=null;this.parentNode.textContent=\'📷\'">':'';
    // B: BSR推算 + 库存监控 双算法销量
    var bsrSales=bsrToMonthly(p);
    var invSales=calcSalesByInventory(p);if(p.stock!==undefined)logStock(p.asin,p.stock);
    var salesTxt='';if(bsrSales)salesTxt=bsrSales+' (BSR)';if(invSales)salesTxt+=(salesTxt?' | ':'')+invSales+' (库存)';
    // Use BSR estimate as p.monthly for scoring if no Amazon monthly data
    if(!p.monthly&&bsrSales)p.monthly=bsrSales;
    var lk=p.link||('https://www.amazon.com/dp/'+p.asin);
    var tr=document.createElement('tr');tr.style.cssText=cl+';border-bottom:1px solid #f0f0f0';tr.setAttribute('draggable','true');tr.dataset.asin=p.asin;
    tr.innerHTML='<td style="cursor:grab;text-align:center;color:#ccc">+</td><td><input type="checkbox" '+ch+'></td><td style="text-align:center">'+ic+'</td><td style="font-size:9px">'+p.asin+'</td><td style="max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(p.title||'').replace(/"/g,'&quot;')+'">'+(p.title||'')+'</td><td style="font-size:10px">'+(p.brand||'--')+'</td><td>'+(p.price?'$'+p.price:'--')+'</td><td style="font-weight:bold;'+tc+'">'+tmr+'</td><td style="font-weight:bold">'+(p.score||'--')+(invSales||bsrSales?'<span style="color:#52c41a;font-size:7px" title="BSR推算:'+(bsrSales||'N/A')+' | 库存:'+(invSales||'N/A')+' | Amazon:'+(p.monthly||'N/A')+'">📊</span>':'')+'</td><td style="cursor:pointer;text-align:center;font-size:14px">'+th+'</td><td style="font-size:9px;color:#888">'+nt+'</td><td style="font-size:9px"><a href="'+lk+'" target="_blank" style="color:#1677ff">link</a></td><td style="text-align:center;cursor:pointer;color:#ccc;font-size:16px" title="删除此条" class="wb-del">×</td>';
    var hsc=hsFor(p);var hsTd=document.createElement('td');hsTd.style.cssText='font-size:9px;color:#722ed1;cursor:pointer';hsTd.title=hsc.name+' | 关税 '+hsc.tariff+'%';hsTd.textContent=hsc.code;hsTd.addEventListener('dblclick',function(){var c=wbHS[p.asin]?wbHS[p.asin].code:hsc.code;var inp=prompt('HS编码(手动输入):',c);if(inp===null)return;wbHS[p.asin]={code:inp.trim(),name:hsc.name,tariff:hsc.tariff,_manual:true,_brand:(p.brand||'').toLowerCase().trim()};saveCorrection(p.brand,'hsCode',inp.trim());hsSave();rWB(prods,tid,cid,pfx);});tr.appendChild(hsTd);
    tr.querySelector('input[type=checkbox]').addEventListener('change',function(){wbChecked[p.asin]=this.checked;});
    var tds=tr.querySelectorAll('td');tds[9].addEventListener('click',function(){var cy=['','priority','maybe','reject'];var c=wbTags[p.asin]||'';var n=cy[(cy.indexOf(c)+1)%4];wbTags[p.asin]=n;if(!n)delete wbTags[p.asin];save();rWB(prods,tid,cid,pfx);});
    tds[10].addEventListener('dblclick',function(){var c=wbNotes[p.asin]||'';var inp=prompt('备注(50字):',c);if(inp===null)return;if(inp.length>50)inp=inp.substr(0,50);wbNotes[p.asin]=inp.trim();if(!wbNotes[p.asin])delete wbNotes[p.asin];save();rWB(prods,tid,cid,pfx);});
    var delTd=tr.querySelector('.wb-del');if(delTd)delTd.addEventListener('click',function(e){e.stopPropagation();if(confirm('Delete '+p.asin+'?')){deleteProduct(prods,p.asin,pfx);}});
    tb.appendChild(tr);
  });
  document.getElementById(cid).textContent=prods.length+'件';
  tb.querySelectorAll('tr[draggable]').forEach(function(tr){
    tr.addEventListener('dragstart',function(e){dragSrc=this;this.style.opacity='0.5';e.dataTransfer.effectAllowed='move';});
    tr.addEventListener('dragend',function(){this.style.opacity='';dragSrc=null;});
    tr.addEventListener('dragover',function(e){e.preventDefault();e.dataTransfer.dropEffect='move';});
    tr.addEventListener('dragenter',function(e){e.preventDefault();this.style.borderTop='2px solid #1677ff';});
    tr.addEventListener('dragleave',function(){this.style.borderTop='';});
    tr.addEventListener('drop',function(e){e.preventDefault();this.style.borderTop='';if(!dragSrc||dragSrc===this)return;var sa=dragSrc.dataset.asin,da=this.dataset.asin;var si=prods.findIndex(function(x){return x.asin===sa;}),di=prods.findIndex(function(x){return x.asin===da;});if(si<0||di<0)return;var it=prods.splice(si,1)[0];prods.splice(di,0,it);rWB(prods,tid,cid,pfx);});});
}
// LTR
function ltr(prods,pfx){
  var kp=prods.filter(function(p){return wbChecked[p.asin]===true;});
  if(!kp.length){alert('请勾选至少1个产品');return;}
  var dl=prods.filter(function(p){return !wbChecked[p.asin];});
  if(!dl.length){alert('全部选中，无法学习差异');return;}
  function av(arr,f){var s=0;arr.forEach(function(x){s+=f(x)||0;});return s/arr.length;}
  var kpr=av(kp,function(p){return parseFloat(p.price)||0;}),dpr=av(dl,function(p){return parseFloat(p.price)||0;});
  var kbs=av(kp,function(p){var b=parseInt(p.bsr)||500000;return 1-b/500000;}),dbs=av(dl,function(p){var b=parseInt(p.bsr)||500000;return 1-b/500000;});
  var kcr=av(kp,function(p){return Math.log10((parseInt(p.reviews)||1)+1);}),dcr=av(dl,function(p){return Math.log10((parseInt(p.reviews)||1)+1);});
  var krt=av(kp,function(p){return parseFloat(p.rating)||0;}),drt=av(dl,function(p){return parseFloat(p.rating)||0;});
  var kbr=av(kp,function(p){var b=(p.brand||'').toLowerCase();return(b&&b!=='generic'&&b!=='from the author')?1:0;}),dbr=av(dl,function(p){var b=(p.brand||'').toLowerCase();return(b&&b!=='generic'&&b!=='from the author')?1:0;});
  var ksf=av(kp,function(p){var t=tm(p.brand);return(t==='0'||t==='?')?1:0;}),dsf=av(dl,function(p){var t=tm(p.brand);return(t==='0'||t==='?')?1:0;});
  var ds=[{k:'price',old:W.price||20,v:Math.abs(kpr-dpr)/(Math.max(kpr,dpr)||1)},{k:'demand',old:W.demand||25,v:Math.abs(kbs-dbs)},{k:'competition',old:W.competition||20,v:Math.abs(kcr-dcr)/(Math.max(kcr,dcr)||0.1)},{k:'brand',old:W.brand||15,v:Math.abs(kbr-dbr)},{k:'safety',old:W.safety||10,v:Math.abs(ksf-dsf)},{k:'social',old:W.social||10,v:Math.abs(krt-drt)/(Math.max(krt,drt)||0.1)}];
  var sm=0;ds.forEach(function(d){sm+=d.v;});
  var nw={};ds.forEach(function(d){var r=sm>0?Math.round(d.v/sm*100):Math.round(100/6);nw[d.k]=Math.round(d.old*0.7+r*0.3);});
  var tw=0;Object.keys(nw).forEach(function(k){tw+=nw[k];});Object.keys(nw).forEach(function(k){nw[k]=Math.round(nw[k]/tw*100);});
  var adj=100-Object.values(nw).reduce(function(a,b){return a+b},0);nw[Object.keys(nw)[0]]+=adj;
  var hf=Math.floor(prods.length/2),tp2=prods.slice(0,hf);
  var acc=Math.round(tp2.filter(function(p){return wbChecked[p.asin];}).length/Math.max(1,kp.length)*100);
  WH.push({time:new Date().toISOString().slice(0,16).replace('T',' '),old:JSON.parse(JSON.stringify(W)),new:JSON.parse(JSON.stringify(nw)),acc:acc,kept:kp.length,total:prods.length});
  if(WH.length>30)WH.shift();W=nw;
  // Also save per-category: use dominant category's weights
  var cats={};prods.forEach(function(p){var c=catFor(p);cats[c]=(cats[c]||0)+1;});
  var domCat=Object.keys(cats).sort(function(a,b){return cats[b]-cats[a];})[0]||'default';
  CW[domCat]=nw;CW['default']=nw;
  save();
  localStorage.setItem('amz_weights_synced',JSON.stringify(W));localStorage.setItem('amz_weights_synced_time',new Date().toISOString());
  var syncP={weights:W,history:[{time:new Date().toISOString().slice(0,16).replace('T',' '),old:JSON.parse(JSON.stringify(W)),new:nw,acc:acc,kept:kp.length,total:prods.length}],source:'plugin'};
  fetch(API_BASE+'/api/weights',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(syncP)}).catch(function(){});
  // PRD 4: 字段修正学习 — 从备注中提取关键词调整权重
  var ntKey={price:0,demand:0,competition:0,brand:0,safety:0};var ntTotal=0;
  kp.forEach(function(p){var n=(wbNotes[p.asin]||'').toLowerCase();if(!n)return;
    if(/便宜|价低|price|cost/i.test(n)){ntKey.price+=0.5;ntTotal++;}
    if(/销量|好卖|热销|demand|sell/i.test(n)){ntKey.demand+=1;ntTotal++;}
    if(/竞争|竞品|compet/i.test(n)){ntKey.competition+=0.5;ntTotal++;}
    if(/品牌|brand/i.test(n)){ntKey.brand+=0.5;ntTotal++;}
    if(/太重|体积|大|尺寸|weight|large|dimens/i.test(n)){ntKey.safety+=1;ntTotal++;}
    if(/关税|tariff|HS|编码|custom/i.test(n)){ntKey.safety+=0.5;ntTotal++;}
  });
  if(ntTotal>0){Object.keys(ntKey).forEach(function(k){nw[k]=Math.round(nw[k]+ntKey[k]*2);});var ntw=0;Object.keys(nw).forEach(function(k){ntw+=nw[k];});Object.keys(nw).forEach(function(k){nw[k]=Math.round(nw[k]/ntw*100);});var nta=100-Object.values(nw).reduce(function(a,b){return a+b},0);nw[Object.keys(nw)[0]]+=nta;}

  alert('LTR Done! Acc:'+acc+'% '+(acc>=85?'PASS':'<85%')+' | '+kp.length+'/'+prods.length+' kept'+(acc>=85?' | Synced':'')+(ntTotal>0?' | Dict('+ntTotal+')':''));
  prods.forEach(function(p){sc(p);});prods.sort(function(a,b){return(b.score||0)-(a.score||0);});rWB(prods,pfx+'-wb-table',pfx+'-wb-count',pfx);
}

// === 商标查询: 后台缓存 → USPTO(浏览器) → 上传共享缓存 ===
function checkTrademarks(prods,pfx){
  if(!prods.length){alert('No data');return;}
  var brands=[],seen={},uncached=[];
  prods.forEach(function(p){
    var b=(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').toLowerCase().trim();
    if(!b||b==='generic'||b==='from the author'||seen[b])return;
    if(TM_CACHE[b]!==undefined)return;
    seen[b]=true;uncached.push(b);brands.push(p.brand);
  });
  if(!brands.length){alert('All brands cached');return;}
  var st=document.getElementById(pfx+'-status');
  if(st){st.style.display='block';st.textContent='Checking TM... '+brands.length+' brands';st.className='status-bar';}

  // Step 1: Check shared backend cache first
  fetch(API_BASE+'/api/trademark-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brands:brands})})
    .then(function(r){return r.json();})
    .then(function(shared){
      // Load any hits from shared cache
      var needLookup=[];
      Object.keys(shared).forEach(function(brand){
        var k=brand.replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').toLowerCase().trim();
        if(k&&shared[brand]!==null&&shared[brand]!==undefined){TM_CACHE[k]=shared[brand];}
        else if(shared[brand]===null){needLookup.push(brand);}
      });
      if(!needLookup.length){
        save(); prods.forEach(function(p){sc(p);});prods.sort(function(a,b){return(b.score||0)-(a.score||0);});rWB(prods,pfx+'-wb-table',pfx+'-wb-count',pfx);
        if(st)st.textContent='TM Done ('+brands.length+' from cache)';
        return;
      }

      // Step 2: Query USPTO from browser (background.js)
      if(st)st.textContent='USPTO lookup... '+needLookup.length+' brands';
      chrome.runtime.sendMessage({action:'checkTrademarksBatch',brands:needLookup},function(results){
        var toCache={};
        if(results){Object.keys(results).forEach(function(brand){
          var k=brand.replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').toLowerCase().trim();
          if(k&&results[brand]&&results[brand].registered!==undefined){tmSet(brand,results[brand].registered);toCache[brand]=results[brand].registered;}
        });save();}

        // Step 3: Upload to shared cache (best effort)
        if(Object.keys(toCache).length){
          fetch(API_BASE+'/api/tm-cache',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(toCache)}).catch(function(){});
        }

        prods.forEach(function(p){sc(p);});prods.sort(function(a,b){return(b.score||0)-(a.score||0);});rWB(prods,pfx+'-wb-table',pfx+'-wb-count',pfx);
        if(st)st.textContent='TM Done! '+Object.keys(toCache).length+' new cached';
      });
    })
    .catch(function(){
      // Backend down — fallback to background.js directly
      chrome.runtime.sendMessage({action:'checkTrademarksBatch',brands:brands},function(results){
        if(results){Object.keys(results).forEach(function(brand){
          var k=brand.replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').toLowerCase().trim();
          if(k&&results[brand]&&results[brand].registered!==undefined)tmSet(brand,results[brand].registered);
        });save();}
        prods.forEach(function(p){sc(p);});prods.sort(function(a,b){return(b.score||0)-(a.score||0);});rWB(prods,pfx+'-wb-table',pfx+'-wb-count',pfx);
        if(st)st.textContent='TM Check Done!';
      });
    });
}

// === 上传至面板 ===
function uploadToBackend(prods,pfx){
  if(!prods.length){alert('No data');return;}
  var st=document.getElementById(pfx+'-status');
  if(st){st.style.display='block';st.textContent='Uploading...';st.className='status-bar';}
  var clean=prods.map(function(p){var hsc=hsFor(p);return{asin:p.asin,title:p.title||'',brand:(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim(),price:p.price||'',rating:p.rating||'',reviews:p.reviews||0,bsr:p.bsr||'',monthly:p.monthly||'',shipping:p.shipping||'',weight:p.weight||'',dims:p.dims||'',image:p.image||'',link:p.link||('https://www.amazon.com/dp/'+p.asin),score:p.score||0,tmSt:tm(p.brand),hsCode:hsc.code,hsName:hsc.name,hsTariff:hsc.tariff};});
  fetch(API_BASE+'/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({products:clean,source:pfx,time:new Date().toISOString()})})
    .then(function(r){return r.json();})
    .then(function(d){if(st)st.textContent='Uploaded! '+d.total+' total (+'+d.added+' new)';})
    .catch(function(e){if(st){st.textContent='Upload failed: '+e.message;st.className='status-bar error';}});
}

// Bind submit buttons
setTimeout(function(){
  var eb=document.getElementById('ex-ltr-submit');if(eb)eb.onclick=function(){if(exProducts.length)ltr(exProducts,'ex');else alert('no data');};
  var fb=document.getElementById('fs-ltr-submit');if(fb)fb.onclick=function(){if(fsProducts.length)ltr(fsProducts,'fs');else alert('no data');};
  // Bind select all in fission
  var sa=document.querySelector('#fs-workbench button[onclick*=selectAll]');if(sa)sa.onclick=function(){fsProducts.forEach(function(p){wbChecked[p.asin]=true;});rWB(fsProducts,'fs-wb-table','fs-wb-count','fs');};
  var exTc=document.getElementById('ex-tm-check');if(exTc)exTc.onclick=function(){checkTrademarks(exProducts,'ex');};
  var fsTc=document.getElementById('fs-tm-check');if(fsTc)fsTc.onclick=function(){checkTrademarks(fsProducts,'fs');};
  var exUl=document.getElementById('ex-upload');if(exUl)exUl.onclick=function(){uploadToBackend(exProducts,'ex');};
  var fsUl=document.getElementById('fs-upload');if(fsUl)fsUl.onclick=function(){uploadToBackend(fsProducts,'fs');};
  // Clear buttons
  var exCl=document.getElementById('ex-clear');if(exCl)exCl.onclick=function(){if(confirm('清空类目导出全部数据？'))clearProducts(exProducts,'ex');};
  var fsCl=document.getElementById('fs-clear');if(fsCl)fsCl.onclick=function(){if(confirm('清空裂变搜索全部数据？'))clearProducts(fsProducts,'fs');};
  // Restore saved workbench data
  restoreWorkbench('ex');
  restoreWorkbench('fs');
},200);

// UI only, fetch loops run in background.js (persist across popup close)
chrome.runtime.onMessage.addListener(function(msg){
  if(msg.type==='export-progress'){
    var st=document.getElementById('ex-status');
    if(st){st.style.display='block';st.textContent=msg.msg;st.className='status-bar';}
    var bt2=document.getElementById('ex-start');if(bt2&&msg.done<msg.total)bt2.textContent=msg.done+'/'+msg.total;
    var pb=document.getElementById('ex-progress');if(pb){pb.style.display='block';pb.innerHTML='<div class="bar"><div class="fill" style="width:'+(msg.pct||5)+'%"></div></div>';}
  }
  if(msg.type==='export-done'){
    var products=msg.products||[];
    products.forEach(function(p){sc(p);if(p.stock!==undefined&&p.stock)logStock(p.asin,p.stock);});
    products.sort(function(a,b){return(b.score||0)-(a.score||0)});
    var added=mergeProducts(exProducts,products);
    var pb3=document.getElementById('ex-progress');if(pb3)pb3.style.display='none';
    sDL('ex-download',products,'export');
    var st3=document.getElementById('ex-status');if(st3)st3.textContent='+'+added+' new (total '+exProducts.length+')';
    rWB(exProducts,'ex-wb-table','ex-wb-count','ex');
    var bt2=document.getElementById('ex-start');if(bt2){bt2.disabled=false;bt2.textContent='已完成';}
    setTimeout(function(){checkTrademarks(products,'ex');},300);
  }
  if(msg.type==='fission-progress'){
    var st2=document.getElementById('fs-status');
    if(st2){st2.style.display='block';st2.textContent=msg.msg;st2.className='status-bar';}
    var pb=document.getElementById('fs-progress');if(pb)pb.style.display='block';
    var fill=document.querySelector('#fs-progress .fill');if(fill)fill.style.width=(msg.pct||0)+'%';
  }
  if(msg.type==='fission-done'){
    var fsProds=msg.products||[];
    fsProds.forEach(function(p){p.brand=(p.brand||'').replace(/List:|bought in past month|Amazon.{0,20}Choice|Overall Pick/gi,'').trim();sc(p);if(p.stock!==undefined&&p.stock)logStock(p.asin,p.stock);});
    var tmEl=document.querySelector('input[name="fs-tm"]:checked');var tmVal=tmEl?tmEl.value:'all';
    var salesMin=parseInt(document.getElementById('fs-sales-min').value)||0;
    var salesMaxV=parseInt(document.getElementById('fs-sales-max').value)||0;
    var filterOfficial=document.getElementById('fs-official').checked;
    var bestsellerOnly=document.getElementById('fs-bestseller').checked;
    var shipCbs=document.querySelectorAll('input[name="fs-ship"]:checked');var shipFilters=[];
    shipCbs.forEach(function(cb){shipFilters.push(cb.value);});
    var sellerMin=parseInt(document.getElementById('fs-seller-min').value)||0;
    var filtered=fsProds.filter(function(p){
      if(filterOfficial&&/^amazon/i.test(p.brand||''))return false;
      if(shipFilters.length&&shipFilters.indexOf(p.shipping||'')<0)return false;
      var ms=parseInt(p.monthly)||0;if(salesMin>0&&ms<salesMin)return false;if(salesMaxV>0&&ms>salesMaxV)return false;
      if(tmVal==='yes'&&tm(p.brand)!=='1')return false;if(tmVal==='no'&&tm(p.brand)!=='0')return false;
      if(bestsellerOnly&&!(p.bs||0))return false;
      if(sellerMin>0&&(p._sellerCount||0)<sellerMin)return false;return true;
    });
    filtered.sort(function(a,b){return(b.score||0)-(a.score||0)});
    var added=mergeProducts(fsProducts,filtered);
    sDL('fs-download',filtered,'fission');rWB(fsProducts,'fs-wb-table','fs-wb-count','fs');
    var st=document.getElementById('fs-status');if(st)st.textContent='+'+added+' new (total '+fsProducts.length+') filtered:'+filtered.length;
    var pb2=document.getElementById('fs-progress');if(pb2)pb2.style.display='none';
    var fsBtn=document.getElementById('fs-create');if(fsBtn){fsBtn.textContent='创建并开始';fsBtn.disabled=false;}
    fissionRunning=false;
    setTimeout(function(){checkTrademarks(fsProducts,'fs');},300);
  }
});
document.getElementById('ex-start').addEventListener('click',function(){
  var bt=this,st=document.getElementById('ex-status'),dl2=document.getElementById('ex-download');
  if(!activeTabId){st.style.display='block';st.textContent='No Amazon tab';st.className='status-bar error';return;}
  chrome.runtime.sendMessage({action:'cancelExport'});
  var mx=Math.min(parseInt(document.getElementById('ex-count').value)||50,500);
  st.style.display='block';st.textContent='Starting...';st.className='status-bar';bt.disabled=true;bt.textContent='...';
  if(dl2)dl2.style.display='none';
  document.getElementById('ex-workbench').style.display='none';
  chrome.runtime.sendMessage({action:'startExport',count:mx,tabId:activeTabId});
});

// === Fission: UI only, fetch loop runs in background.js (persists across popup close) ===
document.addEventListener('DOMContentLoaded',function(){
  // Recover export state
  chrome.runtime.sendMessage({action:'getExportState'},function(state){
    if(state&&state.running){
      var exStatus=document.getElementById('ex-status');
      if(exStatus){exStatus.style.display='block';exStatus.textContent='Resuming... '+state.done+'/'+state.total;exStatus.className='status-bar';}
      var exProg=document.getElementById('ex-progress');if(exProg)exProg.style.display='block';
      var exBtn=document.getElementById('ex-start');if(exBtn){exBtn.disabled=true;exBtn.textContent=state.done+'/'+state.total;}
    }
  });
  // Recover fission state
  chrome.runtime.sendMessage({action:'getFissionState'},function(state){
    if(state&&state.running){
      document.getElementById('fs-status').style.display='block';
      document.getElementById('fs-status').textContent='Resuming... '+state.enriched.length+' found';
      document.getElementById('fs-progress').style.display='block';
      document.getElementById('fs-create').textContent='运行中...';
    }
  });
});

document.getElementById('fs-cancel').addEventListener('click',function(){
  fissionRunning=false;
  chrome.runtime.sendMessage({action:'cancelFission'});
  document.getElementById('fs-status').style.display='none';
  document.getElementById('fs-progress').style.display='none';
  document.getElementById('fs-create').textContent='创建并开始';document.getElementById('fs-create').disabled=false;
  var d=document.getElementById('fs-download');if(d)d.style.display='none';
  document.getElementById('fs-workbench').style.display='none';
});

document.getElementById('fs-create').addEventListener('click',function(){
  if(fissionRunning){chrome.runtime.sendMessage({action:'cancelFission'});fissionRunning=false;}
  var m=document.getElementById('fs-url').value.trim().match(/[A-Z0-9]{10}/);if(!m){alert('No valid ASIN');return;}
  var seed=m[0],target=parseInt(document.getElementById('fs-count').value)||100;
  fissionRunning=true;
  var st=document.getElementById('fs-status');st.style.display='block';st.className='status-bar';st.textContent='Starting...';
  document.getElementById('fs-progress').style.display='block';
  var d2=document.getElementById('fs-download');if(d2)d2.style.display='none';
  document.getElementById('fs-workbench').style.display='none';
  this.textContent='运行中...';this.disabled=true;

  var filters={
    tm: (document.querySelector('input[name="fs-tm"]:checked')||{}).value||'all',
    salesMin: parseInt(document.getElementById('fs-sales-min').value)||0,
    salesMax: parseInt(document.getElementById('fs-sales-max').value)||0,
    filterOfficial: document.getElementById('fs-official').checked,
    bestsellerOnly: document.getElementById('fs-bestseller').checked,
    ships: (function(){var r=[];document.querySelectorAll('input[name="fs-ship"]:checked').forEach(function(cb){r.push(cb.value);});return r;})()
  };
  chrome.runtime.sendMessage({action:'startFission',seed:seed,target:target,filters:filters,tabId:activeTabId});
});

document.getElementById('fs-seller-start').addEventListener('click',function(){
  if(fissionRunning){chrome.runtime.sendMessage({action:'cancelFission'});fissionRunning=false;}
  var m=document.getElementById('fs-url').value.trim().match(/[A-Z0-9]{10}/);if(!m){alert('No valid ASIN');return;}
  var seed=m[0],target=parseInt(document.getElementById('fs-count').value)||100;
  fissionRunning=true;
  var st=document.getElementById('fs-status');st.style.display='block';st.className='status-bar';st.textContent='Store scan...';
  document.getElementById('fs-progress').style.display='block';
  var d2=document.getElementById('fs-download');if(d2)d2.style.display='none';
  document.getElementById('fs-workbench').style.display='none';
  document.getElementById('fs-create').textContent='关键词裂变';document.getElementById('fs-create').disabled=false;
  this.textContent='运行中...';this.disabled=true;
  chrome.runtime.sendMessage({action:'startFissionSeller',seed:seed,target:target,tabId:activeTabId});
});
var lastAutoUpload=parseInt(localStorage.getItem('amz_last_auto_upload')||'0');
setInterval(function(){
  var now=Date.now();
  if(now-lastAutoUpload>86400000){
    var all=exProducts.concat(fsProducts);
    if(all.length){uploadToBackend(all,'auto');lastAutoUpload=now;localStorage.setItem('amz_last_auto_upload',String(now));}
  }
},3600000); // check every hour

})();
