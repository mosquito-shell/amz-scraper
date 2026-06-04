/**
 * Amazon 选品运营管理平台 - Dashboard Logic
 * 包含: 仪表盘/排名/商标/裂变搜索/财务指标/权重配置
 */

// ========== Data & State ==========
var DATA = [];
var CACHED_DATA_KEY = 'amz_cached_data';
var WEIGHTS = JSON.parse(localStorage.getItem('amz_weights') || '{"price":20,"demand":25,"competition":20,"brand":15,"safety":10,"social":10}');
var currentPage = 'dashboard';
var fissionRunning = false;
var API_BASE = 'https://api.tsscjn.top';

// 从 shared_data.json 加载 (部署后和本地同目录)
var SHARED_DATA_URL = 'shared_data.json';
// 本地 file:// fallback
if (window.location.protocol === 'file:') {
  SHARED_DATA_URL = '../shared_data.json';
}

// ========== Init ==========
function init(){
  // 读取插件/面板同步的最新权重
  var syncedWeights = localStorage.getItem('amz_weights_synced');
  if(syncedWeights){ try{ var sw = JSON.parse(syncedWeights); WEIGHTS = sw; }catch(e){} }

  // Try loading from CF Worker API (backend)
  loadFromBackend(function(backendOk){
    if(backendOk) console.log('Dashboard: loaded from backend API');

    // Priority: 1) Backend API  2) Plugin-synced data  3) localStorage cached  4) Embedded data
  var pluginData = localStorage.getItem('amz_cached_data');
  var lastImport = localStorage.getItem('amz_last_import');
  if(pluginData && lastImport){
    try{
      var pd = JSON.parse(pluginData);
      if(pd.length){
        DATA = pd.map(function(p){return JSON.parse(JSON.stringify(p));});
        console.log('Loaded '+DATA.length+' products from plugin sync ('+JSON.parse(lastImport).time+')');
        bootApp();
        loadSharedData(); return;
      }
    }catch(e){}
  }

  if(typeof EMBEDDED_DATA !== 'undefined' && EMBEDDED_DATA.length){
    DATA = EMBEDDED_DATA.map(function(p){return JSON.parse(JSON.stringify(p));});
    bootApp();
  }

  // Then refresh with any better data source
  loadSharedData();
  });
}

// === 从后端 API 加载数据 ===
function loadFromBackend(callback){
  fetch(API_BASE+'/api/weights')
    .then(function(r){return r.json();})
    .then(function(d){
      if(d&&d.weights){
        WEIGHTS=d.weights;
        localStorage.setItem('amz_weights',JSON.stringify(d.weights));
        localStorage.setItem('amz_weights_synced',JSON.stringify(d.weights));
        localStorage.setItem('amz_weights_synced_time',d.last_update||new Date().toISOString());
        console.log('Backend weights loaded:',d.last_update);
      }
    })
    .catch(function(){});
  fetch(API_BASE+'/api/products')
    .then(function(r){return r.json();})
    .then(function(d){
      if(d&&Array.isArray(d)&&d.length){
        DATA=d.map(function(p){return JSON.parse(JSON.stringify(p));});
        try{localStorage.setItem(CACHED_DATA_KEY,JSON.stringify(DATA));}catch(e){}
        try{localStorage.setItem('amz_cached_data',JSON.stringify(DATA));}catch(e){}
        try{localStorage.setItem('amz_last_import',JSON.stringify({time:new Date().toISOString(),count:d.length,source:'backend'}));}catch(e){}
        console.log('Backend products loaded:'+d.length);
        bootApp();
        callback(true);
        return;
      }
      callback(false);
    })
    .catch(function(){callback(false);});
}

function loadSharedData(){
  console.log('Loading data from:', SHARED_DATA_URL);
  fetch(SHARED_DATA_URL)
    .then(function(r){
      console.log('Fetch response:', r.status, r.ok);
      return r.json();
    })
    .then(function(json){
      console.log('Parsed', (json.products||[]).length, 'products');
      DATA = (json.products || []).map(function(p){return JSON.parse(JSON.stringify(p));});
      try{localStorage.setItem(CACHED_DATA_KEY,JSON.stringify(DATA));}catch(e){}
      bootApp();
    })
    .catch(function(e){
      console.warn('Data load failed, using current data');
      // bootApp already called with embedded data, nothing more needed
    });
}

function saveSharedData(){
  try{
    localStorage.setItem(CACHED_DATA_KEY,JSON.stringify(DATA));
    localStorage.setItem(CACHED_DATA_KEY+'_time',String(Date.now()));
  }catch(e){}
}

// ========== BSR → 销量估算 ==========
function bsrToSales(rank, category){
  var r=parseInt(String(rank||'999999').replace(/,/g,''));
  if(!r||isNaN(r)) return '-';
  var coeff=1.0;
  if(category&&/clothing|shoes|jewelry/i.test(category)) coeff=1.3;
  if(category&&/sports|outdoor/i.test(category)) coeff=0.8;
  var est=Math.round(coeff*1000000/Math.pow(r,0.9));
  return est>=1000?Math.round(est/100)*100+'+':est>=100?Math.round(est/10)*10+'+':est+'+';
}
function isOfficial(brand,title){
  if(!brand)return false;
  var b=brand.toLowerCase();
  return ['amazon','amazon basics','amazon essentials','echo','fire','kindle','ring','blink','eero'].some(function(o){return b.indexOf(o)===0||(title||'').toLowerCase().indexOf(o+' ')===0;});
}

function bootApp(){
  // 标记商标 + 销量估算 + 官方店 + 配送
  DATA.forEach(function(p){
    var b = (p.brand||'').toLowerCase().trim();
    p._tmStatus = TRADEMARK_DB[b] || (b&&b!=='generic'?'待查':'无品牌名');
    // BSR 销量估算
    var bsr=((p.bsr||[])[0]||{});
    p._estSales = bsrToSales(bsr.rank, bsr.category);
    // 官方店
    p._official = isOfficial(p.brand, p.title);
    // 配送(默认 Prime/FBA)
    p._shipping = p._shipping || 'Prime';
  });
  scoreAll(DATA);
  restoreUserData(); // 恢复人工排序、标记、备注
  // 恢复权重
  var ids = ['wPrice','wDemand','wCompetition','wBrand','wSafety','wSocial'];
  var keys = ['price','demand','competition','brand','safety','social'];
  ids.forEach(function(id,i){
    var el=document.getElementById(id);if(el) el.value=WEIGHTS[keys[i]];
    var labelEl = document.getElementById(id+'Label');
    if(labelEl) labelEl.textContent = WEIGHTS[keys[i]]+'%';
  });
  // Nav
  document.querySelectorAll('.sidebar nav a').forEach(function(a){
    a.addEventListener('click',function(e){
      e.preventDefault();switchPage(this.dataset.page);
    });
  });
  renderDashboard();
  renderSettingsHistory(); // Pre-render weights history
}

// ========== Legacy: SAMPLE_DATA for compatibility ==========
var SAMPLE_DATA = [
  {asin:'B0DX6Q2K5D',title:'Gokeey Gold Bracelets Set for Women Non Tarnish, 14K Gold Plated Sterling Silver',brand:'Gokeey',price_usd:12.56,rating:4.5,review_count:1258,bsr:[{rank:'255',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'200+',is_sponsored:false},
  {asin:'B0G6Y2JPG6',title:'AboveGenius Badminton Rackets Set of 2, Lightweight Outdoor Backyard Portable Game',brand:'AboveGenius',price_usd:15.99,rating:4.4,review_count:48,bsr:[{rank:'9,271',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B097GFDBFD',title:'AboveGenius Badminton Rackets Set of 4 with 6 Nylon Birdies, Outdoor Backyard Game',brand:'AboveGenius',price_usd:31.99,rating:4.5,review_count:357,bsr:[{rank:'8,072',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B00FPQQIAA',title:'Franklin Sports Badminton Racket + Birdie Set - Kids and Adults Equipment',brand:'Franklin Sports',price_usd:14.99,rating:4.2,review_count:12864,bsr:[{rank:'1,401',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B08BNJT83C',title:'HIRALIY Badminton Rackets Set for Backyards, 4 Rackets, 12 Birdies, Carrying Bag',brand:'HIRALIY',price_usd:39.99,rating:4.6,review_count:3572,bsr:[{rank:'1,200',category:'Sports & Outdoors'}],monthly_bought:'200+',is_sponsored:false},
  {asin:'B0DYTPTMD7',title:'HIRALIY Badminton Rackets Set for Backyards, 4 Rackets 12 Birdies, Carrying Bag',brand:'HIRALIY',price_usd:32.99,rating:4.6,review_count:3572,bsr:[{rank:'1,200',category:'Sports & Outdoors'}],monthly_bought:'200+',is_sponsored:false},
  {asin:'B0C3QWLFTL',title:'AUTOMET Womens Wide Leg Pants High Waisted Lounge Yoga Palazzo, Flowy Casual',brand:'AUTOMET',price_usd:19.99,rating:4.3,review_count:6400,bsr:[{rank:'25',category:'Clothing, Shoes & Jewelry'}],is_sponsored:false},
  {asin:'B0926VJNKK',title:'EAGLES Glow in The Dark Badminton Shuttlecocks, 10 Pack LED Light Up Birdies',brand:'EAGLES',price_usd:8.85,rating:4.5,review_count:1385,bsr:[{rank:'1,739',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0FH8ZYLJL',title:'18K Gold Plated Bangle Bracelet Set Women Stackable Lucky Floral Adjustable Tennis',brand:'Generic',price_usd:18.99,rating:4.3,review_count:352,bsr:[{rank:'4,884',category:'Clothing, Shoes & Jewelry'}],is_sponsored:false},
  {asin:'B083PB9GFY',title:'CRZ YOGA Womens Butterluxe High Waist Lounge Leggings 28, Ultra Soft Stretch',brand:'CRZ YOGA',price_usd:28.00,rating:4.6,review_count:52000,bsr:[{rank:'2',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'10K+',is_sponsored:false},
  {asin:'B09YDH5S5Z',title:'THE GYM PEOPLE Womens Joggers Pants with Pockets, Lightweight Athletic Tapered',brand:'THE GYM PEOPLE',price_usd:29.99,rating:4.4,review_count:8900,bsr:[{rank:'18',category:'Clothing, Shoes & Jewelry'}],is_sponsored:false},
  {asin:'B0C2P72WY6',title:'DEARMAY Gold Bracelets for Women Waterproof, 14K Gold Plated Stackable Jewelry Set',brand:'DEARMAY',price_usd:13.99,rating:4.4,review_count:5922,bsr:[{rank:'1,716',category:'Clothing, Shoes & Jewelry'}],is_sponsored:false},
  {asin:'B0CTK5RTR1',title:'KH Badminton Rackets Set of 2 4 6 for Adults Kids, Beach Lawn Backyard Outdoor',brand:'Keehoo',price_usd:29.99,rating:4.5,review_count:1409,bsr:[{rank:'5,743',category:'Sports & Outdoors'}],monthly_bought:'200+',is_sponsored:false},
  {asin:'B000FI8ER8',title:'YONEX Mavis 350 Nylon Badminton Shuttlecocks, Yellow, Slow Speed, Durable',brand:'YONEX',price_usd:19.50,rating:4.0,review_count:30744,bsr:[{rank:'950',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B082PCHH2R',title:'Leggings Depot Womens Activewear Yoga Pants with Pockets, Buttery Soft Fabric',brand:'Leggings Depot',price_usd:16.99,rating:4.5,review_count:98765,bsr:[{rank:'1',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'10K+',is_sponsored:false},
  {asin:'B07WLHCKBK',title:'IUGA High Waisted Yoga Pants with Pockets, Tummy Control Workout Leggings',brand:'IUGA',price_usd:24.99,rating:4.5,review_count:42500,bsr:[{rank:'3',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'10K+',is_sponsored:false},
  {asin:'B07V1M47YG',title:'Sunzel Womens Flare Leggings, Crossover High Waist Yoga Pants with Tummy Control',brand:'Sunzel',price_usd:22.99,rating:4.4,review_count:18300,bsr:[{rank:'15',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'5K+',is_sponsored:false},
  {asin:'B08QMDS6RR',title:'Colorfulkoala Womens High Waisted Yoga Pants 7/8 Length Leggings with Pockets',brand:'Colorfulkoala',price_usd:25.00,rating:4.4,review_count:15500,bsr:[{rank:'12',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'5K+',is_sponsored:false},
  {asin:'B07GW258PS',title:'90 Degree By Reflex High Waist Power Flex Yoga Pants - Tummy Control Compression',brand:'90 Degree By Reflex',price_usd:24.00,rating:4.4,review_count:21200,bsr:[{rank:'10',category:'Clothing, Shoes & Jewelry'}],is_sponsored:false},
  {asin:'B097G62X3J',title:'AboveGenius Badminton Rackets Set, Lightweight Durable 12 Racquets 18 Birdies',brand:'AboveGenius',price_usd:38.99,rating:4.5,review_count:565,bsr:[{rank:'6,064',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0CZJF6DT8',title:'16Pcs Gold Bangle Bracelets for Women Multi Layer Stackable Textured Jewelry Set',brand:'Generic',price_usd:12.99,rating:4.3,review_count:1648,bsr:[{rank:'18,690',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'100+',is_sponsored:false},
  {asin:'B0CY27F8C5',title:'FANCIME 925 Sterling Silver Cubic Zirconia Adjustable Tennis Bracelet, 14K Gold',brand:'FANCIME',price_usd:10.31,rating:4.4,review_count:2631,bsr:[{rank:'2,096',category:'Clothing, Shoes & Jewelry'}],is_sponsored:false},
  {asin:'B0F2HWX6PK',title:'BERISO Gold Bracelets for Women, Elegant Adjustable 14K Gold Plated Trendy Minimal',brand:'BERISO',price_usd:12.99,rating:4.5,review_count:555,bsr:[{rank:'15,970',category:'Clothing, Shoes & Jewelry'}],is_sponsored:false},
  {asin:'B0F48V24K1',title:'Bheop Bracelets for Women 14K Gold Silver Plated Ring Bracelet Hand Chain Evil Eye',brand:'Bheop',price_usd:9.99,rating:4.3,review_count:415,bsr:[{rank:'12,413',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'400+',is_sponsored:false},
  {asin:'B0G1BL3C44',title:'Birthstone Gold Clover Bracelet Dainty 14K Gold Plated Cute Friendship Stackable',brand:'Generic',price_usd:9.99,rating:4.7,review_count:128,bsr:[{rank:'6,828',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'200+',is_sponsored:false},
  {asin:'B07KMWDBGJ',title:'Yonex GR 303 Combo Badminton Racquet with Full Cover, Set of 2',brand:'YONEX',price_usd:44.20,rating:4.4,review_count:2411,bsr:[{rank:'12,734',category:'Sports & Outdoors'}],monthly_bought:'300+',is_sponsored:false},
  {asin:'B09MV65W77',title:'Boulder Sports All-in-One Pickleball and Badminton Set - Portable Adjustable Net',brand:'Boulder',price_usd:110.00,rating:4.5,review_count:345,bsr:[{rank:'67,359',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0FPWN739S',title:'Badminton Set Portable Outdoor Anti-Sag System, Official 20ft Net with 4 Rackets',brand:'Outdoor Games',price_usd:59.99,rating:4.5,review_count:51,bsr:[{rank:'15,566',category:'Sports & Outdoors'}],monthly_bought:'100+',is_sponsored:false},
  {asin:'B074RFJHB4',title:'Boulder Portable Badminton Pickleball Net - Foldable Extendable Poles, Multi-Height',brand:'Boulder',price_usd:69.99,rating:4.5,review_count:14454,bsr:[{rank:'3,200',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0926YV2VL',title:'EAGLES Badminton Birdies - Nylon Shuttlecocks, High Visibility Training Balls, 12 Pack',brand:'EAGLES',price_usd:9.85,rating:4.6,review_count:2003,bsr:[{rank:'671',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0C14ZJ2PX',title:'Professional Carbon Fiber Badminton Rackets Set, 2 Racquet with Cover, Lightweight',brand:'PHINIX',price_usd:49.99,rating:4.3,review_count:1200,bsr:[{rank:'22,000',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B00FPQQVD4',title:'Franklin Sports Badminton Set - Portable Adult and Kids Backyard Game, 4 Rackets',brand:'Franklin Sports',price_usd:32.99,rating:4.2,review_count:2384,bsr:[{rank:'13,125',category:'Sports & Outdoors'}],monthly_bought:'200+',is_sponsored:false},
  {asin:'B07H968PFB',title:'Franklin Sports Badminton Net Sets - Outdoor Backyard Beach Complete Set 4 Rackets',brand:'Franklin Sports',price_usd:39.99,rating:4.1,review_count:4356,bsr:[{rank:'10,500',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0CQ86NMK8',title:'Yonex Badminton Racquet Astrox Attack 9, Lightweight Power Frame, Pre-Strung',brand:'YONEX',price_usd:36.95,rating:4.2,review_count:2419,bsr:[{rank:'15,000',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B07BY89TQY',title:'YONEX Nanoray 10F Hi-Flex Pre-Strung Badminton Racquet, Graphite Shaft',brand:'YONEX',price_usd:41.80,rating:4.5,review_count:20985,bsr:[{rank:'8,500',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B00FPQQEJ0',title:'Franklin Sports Volleyball + Badminton Combo Set - Beach Backyard Game, Pump',brand:'Franklin Sports',price_usd:36.56,rating:4.0,review_count:4117,bsr:[{rank:'8,383',category:'Sports & Outdoors'}],monthly_bought:'800+',is_sponsored:false},
  {asin:'B0CLLDWZSP',title:'JOY SPOT! Kids Badminton Rackets Set with Soft Grip, Oversize Lightweight Racquet',brand:'JOY SPOT!',price_usd:17.99,rating:4.5,review_count:352,bsr:[{rank:'50,000',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0G64KBDQX',title:'AboveGenius Badminton Set, Lightweight Rackets with Birdies, Outdoor Backyard Fun',brand:'AboveGenius',price_usd:29.99,rating:4.3,review_count:95,bsr:[{rank:'35,500',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0DR2X6FDG',title:'12ft Badminton Net Set for Backyard Beach, Durable Anti-Sagging Net, Heavy Poles',brand:'Generic',price_usd:59.99,rating:4.8,review_count:33,bsr:[{rank:'48,000',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0737G139M',title:'Badminton Set - Backyard Games 4 Rackets 3 Birdies Regulation-Size Net with Poles',brand:'Park & Sun Sports',price_usd:33.72,rating:4.3,review_count:933,bsr:[{rank:'20,000',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0FG748MV4',title:'FANCIME Birthstone Teardrop Tennis Bracelet, Sterling Silver 9x7mm Gemstone Bolo',brand:'FANCIME',price_usd:119.00,rating:4.7,review_count:119,bsr:[{rank:'103,870',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'50+',is_sponsored:false},
  {asin:'B0814YP5SL',title:'Swarovski Lifelong Heart Necklace Earrings Bracelet Crystal Jewelry Collection',brand:'Swarovski',price_usd:90.00,rating:4.5,review_count:1296,bsr:[{rank:'50,277',category:'Clothing, Shoes & Jewelry'}],monthly_bought:'100+',is_sponsored:false},
  {asin:'B0DKJMHPT1',title:'HIRALIY 12 Pack Badminton Birdies Nylon, Durable Shuttlecocks for Baseball Training',brand:'HIRALIY',price_usd:8.99,rating:4.4,review_count:3041,bsr:[{rank:'1,500',category:'Sports & Outdoors'}],is_sponsored:false},
  {asin:'B0DP6H79LJ',title:'Womens Stackable Floral Gold Bracelets - 3Pcs 18K Gold Plated, Stainless Steel Bangle',brand:'Generic',price_usd:18.99,rating:4.3,review_count:735,bsr:[{rank:'5,206',category:'Clothing, Shoes & Jewelry'}],is_sponsored:false},
  {asin:'B0B759KMKG',title:'Zdgao Badminton Sets for Backyard, Portable Badminton Net with Tension Adjuster',brand:'Zdgao',price_usd:59.99,rating:4.5,review_count:258,bsr:[{rank:'30,836',category:'Sports & Outdoors'}],monthly_bought:'50+',is_sponsored:false},
];

// ========== Trademark data (known brands) ==========
var TRADEMARK_DB = {
  yonex:'已注册',anker:'已注册',wilson:'已注册',baden:'已注册',eastpoint:'已注册',senston:'已注册',hiraliy:'已注册',vevor:'已注册',boulder:'已注册',
  'franklin sports':'已注册','franklin':'已注册','triumph sports':'已注册','eastpoint sports':'已注册','park & sun sports':'已注册',
  keehoo:'已注册',eagles:'已注册',abovegenius:'已注册',zdgao:'已注册','outdoor games':'已注册','joy spot!':'已注册',
  phiniix:'已注册',bheop:'已注册',haokelball:'已注册',wettarn:'已注册',meooeck:'已注册',aoneky:'已注册','peak fits':'已注册',
  nike:'已注册',adidas:'已注册',lululemon:'已注册','the gym people':'已注册',heynuts:'已注册',sunzel:'已注册',colorfulkoala:'已注册',
  '90 degree by reflex':'已注册',automet:'已注册','leggings depot':'已注册',iuga:'已注册','crz yoga':'已注册',
  swarovski:'已注册',pandora:'已注册',pavoi:'已注册','kendra scott':'已注册',dearmay:'已注册',gokeey:'已注册',fancime:'已注册',beriso:'已注册',
  apple:'已注册',samsung:'已注册',sony:'已注册',bose:'已注册',jbl:'已注册',
  hanes:'已注册',gildan:'已注册',champion:'已注册','under armour':'已注册',puma:'已注册',reebok:'已注册',
  'new balance':'已注册',asics:'已注册',mizuno:'已注册',fila:'已注册',head:'已注册',prince:'已注册',
  dunlop:'已注册',lining:'已注册',spalding:'已注册',rawlings:'已注册',easton:'已注册',mikasa:'已注册',
  speedo:'已注册',arena:'已注册',coleman:'已注册','north face':'已注册',patagonia:'已注册',columbia:'已注册',
  levis:'已注册',carhartt:'已注册',dickies:'已注册','calvin klein':'已注册','tommy hilfiger':'已注册','ralph lauren':'已注册',
  fossil:'已注册',timex:'已注册',casio:'已注册',citizen:'已注册',seiko:'已注册','michael kors':'已注册',coach:'已注册',
  'kate spade':'已注册',jansport:'已注册',herschel:'已注册','hydro flask':'已注册',yeti:'已注册',contigo:'已注册',
  'stanley':'已注册','underarmour':'已注册','oakley':'已注册',rayban:'已注册','ray-ban':'已注册',
  disney:'已注册',lego:'已注册',hasbro:'已注册',mattel:'已注册',nerf:'已注册',
  ankke:'已注册','amazon basics':'已注册',
};

// ========== Scoring Engine ==========
function scorePrice(p){if(!p)return 50;if(p<6)return 15;if(p<12)return 60;if(p<=25)return 95;if(p<=40)return 85;if(p<=70)return 60;if(p<=120)return 40;return 15;}
function scoreDemand(bsr,mb){if(Array.isArray(bsr))bsr=bsr[0]&&bsr[0].rank;if(typeof bsr==='string'&&bsr)bsr=parseInt(bsr.replace(/,/g,''));if(!bsr||isNaN(bsr)){if(mb){var n=parseInt(String(mb).replace('+','').replace('K','000'));if(n>=5000)return 90;if(n>=1000)return 75;if(n>=500)return 60;if(n>=100)return 40;return 25}return 30}if(bsr<500)return 98;if(bsr<2000)return 90;if(bsr<5000)return 80;if(bsr<10000)return 65;if(bsr<30000)return 45;if(bsr<50000)return 30;if(bsr<100000)return 15;return 5;}
function scoreCompetition(r){if(!r)return 50;if(r<30)return 90;if(r<100)return 85;if(r<500)return 80;if(r<2000)return 60;if(r<5000)return 40;if(r<15000)return 20;return 5;}
function scoreBrand(b,tm){if(!b||b==='Generic'||b==='From the Author')return 30;if(tm==='未注册'||tm==='待查')return 90;if(tm&&tm.indexOf('已注册')>-1)return 30;return 70;}
function scoreSafety(p){var s=50;if(!p.is_sponsored)s+=25;if(p.brand&&p.brand!=='Generic')s+=15;var tm=p._tmStatus||'';if(tm==='未注册'||tm==='待查')s+=10;if(tm.indexOf('已注册')>-1)s-=10;return Math.max(0,Math.min(100,s));}
function scoreSocial(rating,reviews){if(!rating)return 40;var s=rating*15;if(reviews>100)s+=10;if(reviews>1000)s+=10;return Math.min(100,s);}

function scoreOne(p){
  var tm = p._tmStatus || '';
  var d={};
  d.price=scorePrice(p.price_usd);
  d.demand=scoreDemand(p.bsr,p.monthly_bought);
  d.competition=scoreCompetition(p.review_count);
  d.brand=scoreBrand(p.brand,tm);
  d.safety=scoreSafety(p);
  d.social=scoreSocial(p.rating,p.review_count);
  var total=0;for(var k in d)total+=d[k]*(WEIGHTS[k]||0)/100;
  p._score=Math.round(total*10)/10;p._details=d;return p;
}

function scoreAll(list){list.forEach(scoreOne);list.sort(function(a,b){return(b._score||0)-(a._score||0)});return list;}
function getRec(s){if(s>=80)return'强推';if(s>=70)return'推荐';if(s>=60)return'可试';if(s>=50)return'谨慎';return'不推';}

// (init() is defined above with loadSharedData - this duplicate was removed)

function switchPage(page){
  currentPage = page;
  document.querySelectorAll('.sidebar nav a').forEach(function(a){a.classList.remove('active')});
  document.querySelector('[data-page="'+page+'"]').classList.add('active');
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active')});
  var el = document.getElementById('page-'+page);
  if(el) el.classList.add('active');
  document.getElementById('pageTitle').textContent = {
    dashboard:'📈 仪表盘',ranking:'🏆 选品排名',trademark:'®️ 商标管理',
    finance:'💰 财务指标',learning:'🧠 ML 反馈学习',proxy:'🌐 代理网络',settings:'⚙️ 权重配置'
  }[page]||'';

  if(page==='dashboard') renderDashboard();
  if(page==='ranking') renderRanking();
  if(page==='trademark') renderTrademark();
  if(page==='finance') renderFinance();
  if(page==='learning') renderLearning();
  if(page==='proxy') renderProxy();
  if(page==='settings') renderSettingsHistory();
}

function refreshAll(){
  loadSharedData(); // 重新从 JSON 加载
}

function syncFromBackend(){
  showToast('正在从后端同步...','info');
  loadFromBackend(function(ok){
    if(ok){
      showToast('同步成功! '+DATA.length+' 条产品, 权重已更新','success');
      renderCurrent();
    }else{
      showToast('同步失败: 后端未响应, 请确认 API 已部署','error');
    }
  });
}

function renderCurrent(){
  if(currentPage==='dashboard')renderDashboard();
  else if(currentPage==='ranking')renderRanking();
  else if(currentPage==='trademark')renderTrademark();
  else if(currentPage==='finance')renderFinance();
  else if(currentPage==='learning')renderLearning();
  }

// ========== Dashboard ==========
function renderDashboard(){
  var strong = DATA.filter(function(p){return p._score>=70;}).length;
  var avgPrice = DATA.length ? (DATA.reduce(function(a,b){return a+(b.price_usd||0)},0)/DATA.length).toFixed(0) : 0;
  var avgScore = DATA.length ? (DATA.reduce(function(a,b){return a+b._score},0)/DATA.length).toFixed(1) : 0;
  var regCount = DATA.filter(function(p){return (p._tmStatus||'').indexOf('已注册')>-1}).length;
  var safeCount = DATA.filter(function(p){var t=p._tmStatus||'';return t==='未注册'||t==='待查';}).length;

  document.getElementById('dashStats').innerHTML =
    '<div class="stat-card"><div class="icon blue">📦</div><div class="info"><div class="num">'+DATA.length+'</div><div class="label">总商品数</div></div></div>'+
    '<div class="stat-card"><div class="icon green">🏆</div><div class="info"><div class="num">'+strong+'</div><div class="label">强推 (>70分)</div></div></div>'+
    '<div class="stat-card"><div class="icon orange">💲</div><div class="info"><div class="num">$'+avgPrice+'</div><div class="label">均价</div></div></div>'+
    '<div class="stat-card"><div class="icon purple">📊</div><div class="info"><div class="num">'+avgScore+'</div><div class="label">均分</div></div></div>'+
    '<div class="stat-card"><div class="icon red">®️</div><div class="info"><div class="num">'+regCount+'</div><div class="label">已注册品牌</div></div></div>'+
    '<div class="stat-card"><div class="icon green">✅</div><div class="info"><div class="num">'+safeCount+'</div><div class="label">安全品牌</div></div></div>';

  // Category chart
  var cats = {};
  DATA.forEach(function(p){
    var bsr = (p.bsr||[])[0];
    var cat = bsr ? bsr.category || 'Other' : 'Other';
    if(cat.indexOf('Clothing')>-1)cat='服装珠宝';
    else if(cat.indexOf('Sports')>-1)cat='运动户外';
    else if(cat.indexOf('Electronics')>-1)cat='电子产品';
    else cat='其他';
    cats[cat]=(cats[cat]||0)+1;
  });
  var maxC = Math.max.apply(null,Object.values(cats));
  var chartHTML='';
  Object.keys(cats).forEach(function(k){
    var h = Math.round(cats[k]/maxC*180);
    chartHTML += '<div class="bar" style="height:'+h+'px"><span class="val">'+cats[k]+'</span><span class="lbl">'+k+'</span></div>';
  });
  document.getElementById('categoryChart').innerHTML = chartHTML;

  // Price chart
  var ranges = {'<$10':0,'$10-20':0,'$20-40':0,'$40-70':0,'$70-120':0,'>$120':0};
  DATA.forEach(function(p){
    var pr=p.price_usd||0;
    if(pr<10)ranges['<$10']++;else if(pr<20)ranges['$10-20']++;else if(pr<40)ranges['$20-40']++;
    else if(pr<70)ranges['$40-70']++;else if(pr<120)ranges['$70-120']++;else ranges['>$120']++;
  });
  var maxP = Math.max.apply(null,Object.values(ranges));
  document.getElementById('priceChart').innerHTML = Object.keys(ranges).map(function(k){
    var h=Math.round(ranges[k]/maxP*180);
    return '<div class="bar" style="height:'+h+'px"><span class="val">'+ranges[k]+'</span><span class="lbl">'+k+'</span></div>';
  }).join('');

  // Top 10 table
  var top10 = DATA.slice(0,10);
  var tbody = document.querySelector('#top10Table tbody');
  tbody.innerHTML = top10.map(function(p,i){
    var tm = p._tmStatus||''; var tmb='';
    if(tm.indexOf('已注册')>-1)tmb='<span class="badge badge-red">1</span>';
    else if(tm==='待查')tmb='<span class="badge badge-yellow">?</span>';
    else tmb='<span class="badge badge-green">0</span>';
    var cls=(p._score>=70)?'score-high':((p._score>=50)?'score-mid':'score-low');
    return '<tr class="'+cls+'"><td>'+(i+1)+'</td><td>'+(p.image_url?'<a href="'+p.image_url+'" target="_blank" style="text-decoration:none;font-size:16px" title="点击查看原图">📷</a>':'')+'</td><td>'+p.asin+'</td><td>'+p.title.substr(0,40)+'...</td><td>'+p.brand+'</td><td>$'+p.price_usd+'</td><td>'+p.rating+'★</td><td>'+tmb+'</td><td><b>'+p._score+'</b></td><td><button class="btn btn-sm" onclick="openAmazon(\''+p.asin+'\')">查看</button></td></tr>';
  }).join('');
}

// ========== Ranking ==========
function renderRanking(){
  var display = DATA.slice();

  // 筛选
  var hideOff = document.getElementById('rankHideOfficial')?.checked;
  var hideAd = document.getElementById('rankHideSponsored')?.checked;
  var unregOnly = document.getElementById('rankUnregOnly')?.checked;
  if(hideOff) display = display.filter(function(p){ return !p._official; });
  if(hideAd) display = display.filter(function(p){ return !p.is_sponsored; });
  if(unregOnly) display = display.filter(function(p){ var t=p._tmStatus||''; return t==='待查'||t==='未注册'; });

  document.getElementById('rankCount').textContent = '显示 '+display.length+' / 共 '+DATA.length+' 个商品';
  var tbody = document.querySelector('#rankingTable tbody');
  tbody.innerHTML = display.map(function(p,i){
    var tm = p.tmSt||p._tmStatus||''; var tmb='';
    if(tm==='1') tmb='<span class="badge badge-red">1</span>';
    else if(tm==='?'||tm==='待查') tmb='<span class="badge badge-yellow">?</span>';
    else if(tm==='无品牌名'||!tm) tmb='<span class="badge">-</span>';
    else tmb='<span class="badge badge-green">0</span>';
    var cls=(p._score>=70)?'score-high':((p._score>=50)?'score-mid':'score-low');
    var bsr = (p.bsr||[])[0]; var bsrStr=bsr?bsr.rank||'':'';
    var estSales = bsrToSales(bsrStr, bsr?bsr.category:'');
    var ship = p._shipping || p.shipping || 'Prime';
    var sc = p._score || p.score || 0;
    var img = p.image_url || p.image || '';
    if(img&&img.startsWith('//')) img='https:'+img;
    var pi2 = img ? 'https://proxy.tsscjn.top/?url='+encodeURIComponent(img) : '';
    var price = p.price_usd || p.price || '';
    return '<tr class="'+cls+'"><td>'+(i+1)+'</td><td>'+(pi2?'<a href="'+img+'" target="_blank" style="text-decoration:none;font-size:18px" title="点击查看原图">📷</a>':'')+'</td><td>'+(p.asin||'')+'</td><td>'+(p.title||'').substr(0,45)+'</td><td>'+(p.brand||'')+'</td><td>$'+price+'</td><td>'+(p.rating||'')+'</td><td>'+((p.review_count||p.reviews||0).toLocaleString())+'</td><td>'+bsrStr+'</td><td>'+(estSales||p.monthly||'')+'</td><td>'+(ship||'')+'</td><td>'+tmb+'</td><td><b>'+sc+'</b></td><td>'+getRec(sc)+'</td><td><a href="https://www.amazon.com/dp/'+(p.asin||'')+'" target="_blank" style="color:#1677ff;font-size:10px">查看</a></td></tr>';
  }).join('');
}

// ========== WIPO 商标缓存服务器 (10年有效期) ==========
var TM_SERVER_CACHE = JSON.parse(localStorage.getItem('tm_server_cache')||'{}');
function cacheTM(brand, status){
  var key = brand.toLowerCase().trim();
  TM_SERVER_CACHE[key] = {v:status, ts:Date.now(), expires:Date.now()+3650*86400000}; // 10年
  try{localStorage.setItem('tm_server_cache',JSON.stringify(TM_SERVER_CACHE));}catch(e){}
}
function queryTM(brand){
  if(!brand) return {status:'-', cached:false};
  var key = brand.toLowerCase().trim();
  // 1. 内置库
  if(TRADEMARK_DB[key]) return {status:TRADEMARK_DB[key], cached:true, source:'内置'};
  // 2. 10年服务器缓存
  var entry = TM_SERVER_CACHE[key];
  if(entry && Date.now() < entry.expires) return {status:entry.v, cached:true, source:'缓存('+Math.round((entry.expires-Date.now())/31536000000)+'年)'};
  // 3. 待查
  return {status:'待查', cached:false};
}

// ========== Trademark ==========
function renderTrademark(){
  // Load from backend TM cache + local data
  var brandsMap = {};
  DATA.forEach(function(p){
    var b = p.brand||'Unknown';
    if(!brandsMap[b]) brandsMap[b] = {brand:b,count:0,tm:p.tmSt||'?',minPrice:99999,maxScore:0,hsTariff:p.hsTariff||0,hsCode:p.hsCode||''};
    brandsMap[b].count++;
    if(p.price) brandsMap[b].minPrice = Math.min(brandsMap[b].minPrice, parseFloat(p.price)||99999);
    brandsMap[b].maxScore = Math.max(brandsMap[b].maxScore, p.score||p._score||0);
  });

  // Fetch shared TM cache from backend
  fetch(API_BASE+'/api/tm-cache')
    .then(function(r){return r.json();})
    .then(function(shared){
      if(shared){ Object.keys(shared).forEach(function(k){
        var lk = k.toLowerCase();
        Object.keys(brandsMap).forEach(function(bk){
          if(bk.toLowerCase()===lk){ brandsMap[bk].tm = shared[k]?'1':'0'; }
        });
      });}
      finishRender(brandsMap);
    })
    .catch(function(){ finishRender(brandsMap); });

  function finishRender(brandsMap){
    var list = Object.values(brandsMap);
    list.sort(function(a,b){return b.count-a.count;});
    var reg=0,unreg=0,pending=0;
    list.forEach(function(b){
      // Fallback: if still ?, check local builtin TRADEMARK_DB
      if(b.tm==='?'||b.tm===undefined||b.tm==='待查'){
        var lb=b.brand.toLowerCase().trim();
        if(TRADEMARK_DB[lb]){b.tm=TRADEMARK_DB[lb]==='已注册'?'1':'0';}
      }
      var t=b.tm;if(t==='1')reg++;else if(t==='?'||t==='待查')pending++;else unreg++;
    });
    document.getElementById('tmStats').innerHTML =
      '<div class="stat-card"><div class="icon red">®️</div><div class="info"><div class="num">'+reg+'</div><div class="label">已注册 (后端)</div></div></div>'+
      '<div class="stat-card"><div class="icon green">✅</div><div class="info"><div class="num">'+unreg+'</div><div class="label">未注册/安全</div></div></div>'+
      '<div class="stat-card"><div class="icon yellow">❓</div><div class="info"><div class="num">'+pending+'</div><div class="label">待查</div></div></div>';

    var tbody = document.querySelector('#tmTable tbody');
    tbody.innerHTML = list.map(function(b){
      var tmb='';
      if(b.tm==='1')tmb='<span class="badge badge-red">1 已注册</span>';
      else if(b.tm==='?')tmb='<span class="badge badge-yellow">? 待查</span>';
      else tmb='<span class="badge badge-green">0 未注册</span>';
      return '<tr><td><b>'+b.brand+'</b></td><td>'+b.count+'个</td><td>'+tmb+'</td>'+
        '<td>$'+(b.minPrice<999?b.minPrice.toFixed(2):'--')+'</td><td>'+b.maxScore+'</td>'+
        '<td style="font-size:10px;color:#722ed1">'+(b.hsCode||'')+' ('+(b.hsTariff||'?')+'%)</td>'+
        '<td><button class="btn btn-sm" onclick="openWIPO(\''+b.brand+'\')">WIPO查</button></td></tr>';
    }).join('');
  }
}

function toggleTM(el,brand){
  var cur = el.textContent.trim();
  var next = cur==='1'?'0':(cur==='0'?'?':'1');
  var status = next==='1'?'已注册':(next==='0'?'未注册':'待查');
  el.textContent = next;
  if(next==='1'){el.className='badge badge-red';}
  else if(next==='?'){el.className='badge badge-yellow';}
  else{el.className='badge badge-green';}
  // 保存到 WIPO 缓存服务器 (10年有效期)
  cacheTM(brand, status);
  // Update all products
  DATA.forEach(function(p){
    if((p.brand||'').toLowerCase()===brand.toLowerCase()){
      p._tmStatus = status;
    }
  });
  scoreAll(DATA);
  renderTrademark();
}

function openWIPO(brand){window.open('https://branddb.wipo.int/en/quicksearch/brand/'+encodeURIComponent(brand));}
function openAmazon(asin){window.open('https://www.amazon.com/dp/'+asin);}

// ========== ML 反馈学习系统 ==========
var LEARN_HISTORY = JSON.parse(localStorage.getItem('amz_learn_history')||'[]');

function renderLearning(){
  var learnCount = LEARN_HISTORY.length;
  var lastLearn = LEARN_HISTORY[LEARN_HISTORY.length-1];
  var accuracy = lastLearn ? lastLearn.accuracy : '--';
  var iterCount = learnCount;

  document.getElementById('learnStats').innerHTML =
    '<div class="stat-card"><div class="icon purple">🧠</div><div class="info"><div class="num">'+iterCount+'</div><div class="label">学习轮次</div></div></div>'+
    '<div class="stat-card"><div class="icon green">🎯</div><div class="info"><div class="num">'+(typeof accuracy === 'number' ? accuracy+'%' : '--')+'</div><div class="label">上次一致性</div></div></div>'+
    '<div class="stat-card"><div class="icon orange">📋</div><div class="info"><div class="num">'+(lastLearn?lastLearn.kept:0)+'/'+(lastLearn?lastLearn.total:0)+'</div><div class="label">保留/总数</div></div></div>'+
    '<div class="stat-card"><div class="icon blue">📅</div><div class="info"><div class="num">'+(lastLearn?lastLearn.date:'--')+'</div><div class="label">上次学习时间</div></div></div>';

  // 选品工作台: 渲染可勾选的商品列表
  renderSelectWorkbench();

  // History
  var histHTML = '';
  LEARN_HISTORY.slice().reverse().forEach(function(h,i){
    histHTML += '<div style="padding:6px 0;border-bottom:1px solid #eee;font-size:12px">'+
      '<b>#'+(LEARN_HISTORY.length-i)+'</b> '+h.date+
      ' | 保留 '+h.kept+'/'+h.total+
      ' | 一致性 '+h.accuracy+'%'+
      ' | <button class="btn btn-sm" onclick="rollbackWeights('+i+')">↩ 回滚</button>'+
      '</div>';
  });
  document.getElementById('learnHistory').innerHTML = histHTML || '<div style="color:#999;padding:20px;text-align:center">暂无学习记录</div>';

  // Weight trend
  var vals=[];
  for(var k in WEIGHTS){vals.push({k:k,v:WEIGHTS[k]});}
  var maxV=Math.max.apply(null,vals.map(function(x){return x.v;}));
  document.getElementById('weightTrendChart').innerHTML = vals.map(function(x){
    var h=Math.round(x.v/maxV*160);
    return '<div style="text-align:center"><div class="bar" style="height:'+h+'px;margin:0 auto"><span class="val">'+x.v+'%</span></div><div class="lbl">'+x.k+'</div></div>';
  }).join('');

  document.getElementById('learnStatus').textContent = '';
  document.getElementById('learnResultPanel').style.display = 'none';
}

// ====== 选品工作台: 直接在面板里勾选保留 ======
var productSelections = {};  // asin -> true/false

var productTags = {};     // {asin: 'priority'|'maybe'|'reject'|''}
var productNotes = {};    // {asin: 'note text'}
var dragSrcRow = null;

function renderSelectWorkbench(){
  var tbody = document.querySelector('#selectTable tbody');
  var rows = '';
  DATA.forEach(function(p,i){
    var tm = p._tmStatus||''; var tmb='';
    if(tm.indexOf('已注册')>-1) tmb='<span class="badge badge-red">1</span>';
    else if(tm==='待查') tmb='<span class="badge badge-yellow">?</span>';
    else if(tm==='无品牌名') tmb='<span class="badge">-</span>';
    else tmb='<span class="badge badge-green">0</span>';
    var checked = productSelections[p.asin]===true?'checked':'';
    var cls = p._score>=70?'score-high':(p._score>=50?'score-mid':'score-low');
    var tag = productTags[p.asin]||'';
    var tagHtml = '';
    if(tag==='priority') tagHtml = '<span class="badge badge-green" title="优先">🔝</span>';
    else if(tag==='maybe') tagHtml = '<span class="badge badge-yellow" title="待定">❓</span>';
    else if(tag==='reject') tagHtml = '<span class="badge badge-red" title="排除">✖</span>';
    else tagHtml = '<span style="font-size:9px;color:#ccc">--</span>';
    var note = productNotes[p.asin]||'';
    var noteDisp = note ? note.substr(0,10)+(note.length>10?'…':'') : '';
    rows += '<tr class="'+cls+'" draggable="true" data-asin="'+p.asin+'" style="cursor:grab">'+
      '<td style="cursor:grab;text-align:center;color:#ccc">⋮⋮</td>'+
      '<td><input type="checkbox" '+checked+' onchange="event.stopPropagation();toggleProduct(\''+p.asin+'\',this.checked)"></td>'+
      '<td>'+(p.image_url?'<a href="'+p.image_url+'" target="_blank" style="text-decoration:none;font-size:16px" title="点击查看原图">📷</a>':'')+'</td>'+
      '<td>'+p.asin+'</td>'+
      '<td title="'+(p.title||'').replace(/"/g,'&quot;')+'">'+(p.title||'').substr(0,40)+'</td>'+
      '<td>'+(p.brand||'--')+'</td>'+
      '<td>$'+(p.price_usd||'--')+'</td>'+
      '<td>'+(p.rating||'')+'★</td>'+
      '<td>'+tmb+'</td>'+
      '<td><b>'+(p._score||0)+'</b></td>'+
      '<td onclick="event.stopPropagation();cycleTag(\''+p.asin+'\')" style="cursor:pointer">'+tagHtml+'</td>'+
      '<td ondblclick="event.stopPropagation();editNote(\''+p.asin+'\')" title="'+(note||'双击编辑备注')+'" style="font-size:9px;color:'+(note?'#333':'#ccc')+';max-width:70px;overflow:hidden;cursor:text">'+(note?noteDisp:'')+'</td>'+
      '</tr>';
  });

  tbody.innerHTML = rows;

  // 拖拽排序
  tbody.querySelectorAll('tr[draggable]').forEach(function(tr){
    tr.addEventListener('dragstart',function(e){
      dragSrcRow=this;this.style.opacity='0.5';
      e.dataTransfer.effectAllowed='move';
    });
    tr.addEventListener('dragend',function(){this.style.opacity='';dragSrcRow=null;});
    tr.addEventListener('dragover',function(e){e.preventDefault();e.dataTransfer.dropEffect='move';});
    tr.addEventListener('dragenter',function(e){e.preventDefault();this.style.borderTop='3px solid #1677ff';});
    tr.addEventListener('dragleave',function(){this.style.borderTop='';});
    tr.addEventListener('drop',function(e){
      e.preventDefault();this.style.borderTop='';
      if(!dragSrcRow||dragSrcRow===this)return;
      var sA=dragSrcRow.dataset.asin,dA=this.dataset.asin;
      var si=DATA.findIndex(function(p){return p.asin===sA;});
      var di=DATA.findIndex(function(p){return p.asin===dA;});
      if(si<0||di<0)return;
      var item=DATA.splice(si,1)[0];DATA.splice(di,0,item);
      saveProductOrder();renderSelectWorkbench();
    });
  });

  document.getElementById('selectTotal').textContent = DATA.length;
  updateSelectCount();
}

function cycleTag(asin){
  var tags=['','priority','maybe','reject'];
  var cur=productTags[asin]||'';
  var next=tags[(tags.indexOf(cur)+1)%tags.length];
  productTags[asin]=next;
  if(!next) delete productTags[asin];
  localStorage.setItem('amz_product_tags',JSON.stringify(productTags));
  renderSelectWorkbench();
}

function editNote(asin){
  var cur=productNotes[asin]||'';
  var inp=prompt('备注 (限50字):',cur);
  if(inp===null)return;
  if(inp.length>50)inp=inp.substr(0,50);
  productNotes[asin]=inp.trim();
  if(!productNotes[asin]) delete productNotes[asin];
  localStorage.setItem('amz_product_notes',JSON.stringify(productNotes));
  renderSelectWorkbench();
}

function resetProductOrder(){
  if(!confirm('恢复原始评分排序？'))return;
  DATA.sort(function(a,b){return(b._score||0)-(a._score||0);});
  localStorage.removeItem('amz_product_order');renderSelectWorkbench();
}
function saveProductOrder(){
  localStorage.setItem('amz_product_order',JSON.stringify(DATA.map(function(p){return p.asin;})));
}
function restoreUserData(){
  try{productTags=JSON.parse(localStorage.getItem('amz_product_tags')||'{}');}catch(e){}
  try{productNotes=JSON.parse(localStorage.getItem('amz_product_notes')||'{}');}catch(e){}
  try{
    var order=JSON.parse(localStorage.getItem('amz_product_order')||'[]');
    if(order.length){
      var ordered=[],seen={};
      order.forEach(function(a){var p=DATA.find(function(x){return x.asin===a;});if(p){ordered.push(p);seen[a]=true;}});
      DATA.forEach(function(p){if(!seen[p.asin])ordered.push(p);});
      DATA=ordered;
    }
  }catch(e){}
}

function toggleProduct(asin, checked){
  productSelections[asin] = checked;
  updateSelectCount();
}

function updateSelectCount(){
  var count = Object.values(productSelections).filter(function(v){return v===true;}).length;
  document.getElementById('selectCount').textContent = count;
}

function selectAllProducts(){
  DATA.forEach(function(p){productSelections[p.asin]=true;});
  renderSelectWorkbench();
}
function deselectAllProducts(){
  DATA.forEach(function(p){productSelections[p.asin]=false;});
  renderSelectWorkbench();
}
function selectHighScore(){
  DATA.forEach(function(p){productSelections[p.asin]=p._score>=70;});
  renderSelectWorkbench();
}
function selectLowPrice(){
  DATA.forEach(function(p){productSelections[p.asin]=(p.price_usd||999)<25;});
  renderSelectWorkbench();
}

function submitLearning(){
  var kept = DATA.filter(function(p){return productSelections[p.asin]===true;});
  var keptAsins = kept.map(function(p){return p.asin;});
  if(keptAsins.length===0){alert('请至少勾选一个商品');return;}
  if(keptAsins.length===DATA.length){alert('你保留了所有商品，没有筛选差异，无法学习。请取消一些不想要的商品后再学习。');return;}
  // 纳入标签信息：标记为 reject/排除的不参与学习
  var taggedReject = kept.filter(function(p){return productTags[p.asin]==='reject';});
  if(taggedReject.length) keptAsins = keptAsins.filter(function(a){return productTags[a]!=='reject';});
  doLearning(keptAsins);
}

function exportSelections(){
  var rows=[];
  rows.push('<tr><th>选中</th><th>ASIN</th><th>标题</th><th>品牌</th><th>售价</th><th>评分</th><th>评论</th><th>BSR</th><th>商标</th><th>分数</th><th>链接</th></tr>');
  DATA.forEach(function(p){
    var kept=productSelections[p.asin]===true;
    rows.push('<tr style="'+(kept?'':'background:#eee')+'"><td>'+(kept?'Y':'N')+'</td><td>'+p.asin+'</td><td>'+p.title+'</td><td>'+p.brand+'</td><td>$'+p.price_usd+'</td><td>'+p.rating+'</td><td>'+p.review_count+'</td><td>'+(((p.bsr||[])[0]||{}).rank||'')+'</td><td>'+(p._tmStatus||'')+'</td><td>'+p._score+'</td><td>https://www.amazon.com/dp/'+p.asin+'</td></tr>');
  });
  var html='<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"></head><body><table border="1">'+rows.join('')+'</table></body></html>';
  var blob=new Blob([html],{type:'application/vnd.ms-excel'});
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='选品筛选_'+new Date().toISOString().slice(0,10)+'.xls';a.click();
}

// 拖拽上传
function handleDrop(e){
  e.preventDefault();
  var file = e.dataTransfer.files[0];
  if(!file) return;
  var input = document.getElementById('learnFile');
  var dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  handleFileUpload(input);
}

// 文件上传处理
function handleFileUpload(input){
  var file = input.files[0];
  if(!file){return;}
  var status = document.getElementById('learnStatus');
  status.textContent = '正在解析: '+file.name+'...';

  var reader = new FileReader();
  reader.onload = function(e){
    var content = e.target.result;

    // 检测 JSON 格式 (插件导出)
    if(file.name.endsWith('.json')){
      try{
        var json = JSON.parse(content);
        var products = json.products || [];
        if(!products.length){ status.textContent='⚠️ JSON中无产品数据'; return; }
        // 直接加载到 DATA
        DATA = products.map(function(p){return{
          asin:p.asin,title:p.title||'',brand:p.brand||'',price_usd:p.price_usd||0,
          rating:p.rating||0,review_count:p.review_count||0,bsr:p.bsr||[],
          monthly_bought:p.monthly_bought||'',is_sponsored:p.is_sponsored||false,
          image_url:p.image_url||'',_shipping:p._shipping||'',
          _tmStatus:'待查',
        };});
        // 恢复标记
        products.forEach(function(p){if(p.tag)productTags[p.asin]=p.tag;if(p.note)productNotes[p.asin]=p.note;});
        localStorage.setItem('amz_product_tags',JSON.stringify(productTags));
        localStorage.setItem('amz_product_notes',JSON.stringify(productNotes));
        scoreAll(DATA);saveSharedData();renderLearning();
        status.innerHTML='<div style="color:green;font-weight:bold">✅ 已导入 '+DATA.length+' 个商品! (来自: '+json.source+' '+json.time+')</div>';
        return;
      }catch(e){status.textContent='JSON 解析失败: '+e.message; return;}
    }

    // Excel 导入 (原逻辑)
    var asins = [];
    var rows = content.match(/<tr[^>]*>.*?<\/tr>/gi) || [];
    rows.forEach(function(row){
      var cells = row.match(/<t[dh][^>]*>(.*?)<\/t[dh]>/gi) || [];
      cells.forEach(function(cell){
        var txt = cell.replace(/<[^>]+>/g,'').trim();
        if(/^B0[A-Z0-9]{8}$/.test(txt)){ asins.push(txt); }
        var linkMatch = txt.match(/\/dp\/(B0[A-Z0-9]{8})/);
        if(linkMatch && asins.indexOf(linkMatch[1])===-1){ asins.push(linkMatch[1]); }
      });
    });
    asins = asins.filter(function(a,i,arr){return arr.indexOf(a)===i;});
    if(asins.length===0){ status.textContent='⚠️ 未找到 ASIN。请确认文件格式。'; return; }
    status.textContent = '✅ 解析到 '+asins.length+' 个 ASIN。正在分析...';
    setTimeout(function(){doLearning(asins);},300);
  };
  if(file.name.endsWith('.json')){ reader.readAsText(file); }
  else { reader.readAsText(file); }
}

// 模拟反馈 (不用真Excel)
function simulateLearning(){
  // 从当前数据随机选一些作为"人工保留"
  var shuffled = DATA.slice().sort(function(){return Math.random()-0.5;});
  var keptCount = Math.floor(12 + Math.random()*20);
  var kept = shuffled.slice(0,keptCount);
  var keptAsins = kept.map(function(p){return p.asin;});
  doLearning(keptAsins);
}

// 核心学习算法
function doLearning(keptAsins){
  var keptMap={};
  keptAsins.forEach(function(a){keptMap[a]=true;});

  var kept=[], removed=[];
  DATA.forEach(function(p){
    if(keptMap[p.asin]) kept.push(p); else removed.push(p);
  });

  if(kept.length===0){alert('保留的商品数为0，无法学习');return;}
  if(removed.length===0){alert('你保留了所有商品，没有可学习的筛选模式');return;}

  // 分析保留 vs 删除的模式差异
  function avg(arr, fn){return arr.reduce(function(s,x){return s+(fn(x)||0)},0)/arr.length;}

  var keptStats={
    price: avg(kept,function(p){return p.price_usd||0}),
    bsr: avg(kept,function(p){var b=(p.bsr||[])[0];if(!b)return 0;return 1-(parseInt(String(b.rank||'500000').replace(/,/g,''))/500000);}),
    reviews: avg(kept,function(p){return Math.log10((p.review_count||1)+1);}),
    rating: avg(kept,function(p){return p.rating||0;}),
    brandGood: kept.filter(function(p){return p.brand&&p.brand!=='Generic';}).length/kept.length,
    sponsored: kept.filter(function(p){return p.is_sponsored;}).length/kept.length,
    tmSafe: kept.filter(function(p){var t=p._tmStatus||'';return t!=='已注册'&&t.indexOf('已注册')===-1;}).length/kept.length,
  };
  var remStats={
    price: avg(removed,function(p){return p.price_usd||0}),
    bsr: avg(removed,function(p){var b=(p.bsr||[])[0];if(!b)return 0;return 1-(parseInt(String(b.rank||'500000').replace(/,/g,''))/500000);}),
    reviews: avg(removed,function(p){return Math.log10((p.review_count||1)+1);}),
    rating: avg(removed,function(p){return p.rating||0;}),
    brandGood: removed.filter(function(p){return p.brand&&p.brand!=='Generic';}).length/removed.length,
    sponsored: removed.filter(function(p){return p.is_sponsored;}).length/removed.length,
    tmSafe: removed.filter(function(p){var t=p._tmStatus||'';return t!=='已注册'&&t.indexOf('已注册')===-1;}).length/removed.length,
  };

  // 计算各维度重要性(差异越大 → 该维度越影响决策)
  var diffs={
    price: Math.abs(keptStats.price-remStats.price)/(Math.max(keptStats.price,remStats.price,1)),
    demand: Math.abs(keptStats.bsr-remStats.bsr),
    competition: Math.abs(keptStats.reviews-remStats.reviews)/Math.max(keptStats.reviews,remStats.reviews,0.1),
    brand: Math.abs(keptStats.brandGood-remStats.brandGood),
    safety: Math.abs(keptStats.sponsored-remStats.sponsored)+Math.abs(keptStats.tmSafe-remStats.tmSafe),
    social: Math.abs(keptStats.rating-remStats.rating)/Math.max(keptStats.rating,remStats.rating,0.1),
  };

  // 归一化差异 → 新权重
  var sumDiff=0;
  for(var k in diffs) sumDiff+=diffs[k];
  var newWeights={};
  var totalW=0;
  // 新旧权重混合 (70%旧 + 30%新)
  for(k in diffs){
    var rawW = sumDiff>0 ? Math.round(diffs[k]/sumDiff*100) : (100/6);
    newWeights[k] = Math.round(WEIGHTS[k]*0.7 + rawW*0.3);
    totalW += newWeights[k];
  }
  // 归一化到100%
  for(k in newWeights){newWeights[k]=Math.round(newWeights[k]/totalW*100);}
  // 微调保证总和100
  var adj=100;for(k in newWeights)adj-=newWeights[k];newWeights[Object.keys(newWeights)[0]]+=adj;

  // 计算一致性(当前排名中有多少被保留的在前50%)
  var halfIdx = Math.floor(DATA.length/2);
  var topHalf = DATA.slice(0,halfIdx);
  var keptInTop = topHalf.filter(function(p){return keptMap[p.asin];}).length;
  var accuracy = Math.round(keptInTop/kept.length*100);

  // 学习理由
  var reasons=[];
  var labels={price:'价格',demand:'需求',competition:'竞争',brand:'品牌',safety:'安全',social:'社交'};
  for(k in diffs){
    var old=WEIGHTS[k],nw=newWeights[k],diff=nw-old;
    if(Math.abs(diff)>=2){
      var dir = diff>0?'增加':'减少';
      var why = '';
      if(k==='price'){
        why = keptStats.price>remStats.price?'你倾向较高价品':'你倾向较低价品';
      }else if(k==='demand'){
        why = keptStats.bsr>remStats.bsr?'你倾向高需求(低BSR)品':'你倾向筛选高BSR品';
      }else if(k==='competition'){
        why = keptStats.reviews<remStats.reviews?'你倾向低评论数(蓝海)品':'你倾向已验证的品';
      }else if(k==='brand'){
        why = keptStats.brandGood>remStats.brandGood?'你倾向有品牌品':'你不太在意品牌';
      }else if(k==='safety'){
        why = keptStats.sponsored<remStats.sponsored?'你倾向非广告品':(keptStats.tmSafe>remStats.tmSafe?'你倾向商标安全品':'');
      }else if(k==='social'){
        why = keptStats.rating>remStats.rating?'你倾向高评分品':'';
      }
      reasons.push({k:k,label:labels[k],old:old,new:nw,diff:diff,why:why});
    }
  }
  reasons.sort(function(a,b){return Math.abs(b.diff)-Math.abs(a.diff);});

  // 显示结果
  document.getElementById('learnResultPanel').style.display='';
  document.getElementById('learnResultTitle').textContent = '一致性 '+accuracy+'% | 保留 '+kept.length+'/'+DATA.length;
  document.getElementById('learnStatus').textContent = '✅ 学习完成！保留 '+kept.length+' 个, 删除 '+(DATA.length-kept.length)+' 个';

  var tbody = document.querySelector('#learnTable tbody');
  tbody.innerHTML = reasons.map(function(r){
    var cls = r.diff>0?'color:green':'color:red';
    var badge = r.diff>0?'badge-green':'badge-red';
    var sign = r.diff>0?'+':'';
    var applyBtn = Math.abs(r.diff)>=2
      ? '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();WEIGHTS[\''+r.k+'\']='+r.new+';saveWeights();" title="仅应用此维度">应用</button>'
      : '<span style="font-size:10px;color:#bbb">无需调</span>';
    return '<tr><td><b>'+r.label+'</b></td><td>'+r.old+'%</td><td><b style="color:#1677ff">'+r.new+'%</b></td><td><span class="badge '+badge+'">'+sign+r.diff+'%</span></td><td style="font-size:12px;color:#666">'+r.why+'</td><td>'+applyBtn+'</td></tr>';
  }).join('');

  // 更新 WEIGHTS
  for(k in newWeights) WEIGHTS[k]=newWeights[k];
  localStorage.setItem('amz_weights',JSON.stringify(WEIGHTS));
  // 更新设置页
  var keys=['wPrice','wDemand','wCompetition','wBrand','wSafety','wSocial'];
  var kk=['price','demand','competition','brand','safety','social'];
  kk.forEach(function(k,i){var el=document.getElementById(keys[i]);if(el)el.value=WEIGHTS[k];});

  // 保存历史
  LEARN_HISTORY.push({
    date: new Date().toISOString().slice(0,10),
    kept: kept.length, total: DATA.length, accuracy: accuracy,
    oldWeights: JSON.parse(JSON.stringify(WEIGHTS)),
    newWeights: JSON.parse(JSON.stringify(newWeights)),
    reasons: reasons,
  });
  if(LEARN_HISTORY.length>50) LEARN_HISTORY.shift();
  localStorage.setItem('amz_learn_history',JSON.stringify(LEARN_HISTORY));

  // 重新排名
  scoreAll(DATA);
  renderLearning();

  // === LTR 部署: 推送权重到插件 ===
  var deployWeights = {};
  for(k in newWeights) deployWeights[k]=newWeights[k];
  localStorage.setItem('amz_weights_synced',JSON.stringify(deployWeights));
  localStorage.setItem('amz_weights_synced_time',new Date().toISOString());
  localStorage.setItem('amz_weights',JSON.stringify(WEIGHTS));

  // 在学习结果面板顶部显示部署状态
  var statusDiv = document.getElementById('learnStatus');
  if(statusDiv) statusDiv.innerHTML = '<div style="padding:8px 12px;background:#d4edda;border-radius:6px;color:#155724;font-weight:bold;margin-bottom:8px">✅ 权重已部署! 精度='+accuracy+'% | 插件下次打开自动更新新权重</div>';

  // Fallback: alert
  setTimeout(function(){ alert('✅ 权重部署成功!\n\n精度: '+accuracy+'%\n\n新权重已保存，插件下次打开时自动更新。'); }, 300);
}

function rollbackWeights(idx){
  // idx=0 means most recent
  var targetIdx = LEARN_HISTORY.length-1-idx;
  if(targetIdx<0||targetIdx>=LEARN_HISTORY.length) return;
  var prev = LEARN_HISTORY[targetIdx].oldWeights;
  for(var k in prev) WEIGHTS[k]=prev[k];
  localStorage.setItem('amz_weights',JSON.stringify(WEIGHTS));
  scoreAll(DATA);
  showToast('已回滚到版本 #'+(targetIdx+1));
  renderLearning();
}

// ========== Finance Engine ==========
var FIN_CONFIG = JSON.parse(localStorage.getItem('amz_fin_config')||
  '{"commission":0.15,"freightPerKg":45,"exchangeRate":7.2,"vatRate":0,'+
  '"domesticShipping":5,"procurementDays":5,"freightDays":10,"listingDays":3,"salesDays":7,"withdrawDays":14,'+
  '"returnRate":0.03,"storageCostPerUnit":0.50,"storageDays":30}');

function getFBAFee(w){if(!w||w<=0)w=0.5;if(w<=0.25)return 3.22;if(w<=0.75)return 3.86;if(w<=1)return 4.37;if(w<=2)return 5.12;if(w<=3)return 5.87;if(w<=5)return 6.99;if(w<=10)return 9.49;if(w<=20)return 12.87;return 12.87+(w-20)*0.38;}

// 完整产品级指标计算 (文档2: 2.1节)
// 用户手动录入的真实经营数据 (存 localStorage)
var USER_DATA = JSON.parse(localStorage.getItem('amz_userdata')||'{}');
// 格式: { "B0XXXXX": {cost:12.5, sales:200, fba:4.2, freight:1.5} }

function calcProductMetrics(p){
  var cfg=FIN_CONFIG;
  var price=p.price_usd||0; var asin=p.asin||'';
  var ud = USER_DATA[asin] || {};
  var cost   = ud.cost   || p._procurementCost || price*0.35;
  var sales  = ud.sales  || parseInt(String(p.monthly_bought||'').replace(/[+K]/g,'').replace('K','000')) || Math.round((p.review_count||0)/30) || 10;
  var fba    = ud.fba    || getFBAFee(p._weight||0.5);
  var freight= ud.freight|| Math.round(cfg.freightPerKg*(p._weight||0.5)/cfg.exchangeRate*100)/100;
  // HS tariff: use product's hsTariff from backend, or guess
  var tariffRate = (p.hsTariff!==undefined) ? p.hsTariff : guessHSCode(p.title||'').tariff;
  if (ud.hsTariff !== undefined) tariffRate = ud.hsTariff;
  var tariff = Math.round(cost*tariffRate*100)/10000;

  var commission=Math.round(price*cfg.commission*100)/100;
  var vat=Math.round(price*cfg.vatRate*100)/100;
  var returnLoss=Math.round(price*cfg.returnRate*100)/100;
  var storage=cfg.storageCostPerUnit;
  var np=Math.round((price-commission-fba-freight-cost-returnLoss-storage-vat-tariff)*100)/100;
  var monthProfit=Math.round(np*sales);
  var capitalPerUnit=cost+freight+tariff;
  var C=Math.round(capitalPerUnit*sales);
  var roi=C>0?Math.round(monthProfit/C*100):0;
  var T=cfg.procurementDays+cfg.freightDays+cfg.listingDays+cfg.salesDays+cfg.withdrawDays;
  var ITO=Math.round(365/T*10)/10;
  var MNP=Math.round(np*sales);
  var MC=Math.round(capitalPerUnit*sales/30*100)/100;
  var annualROIC=Math.round(roi*(365/T));

  return {asin:asin,title:p.title||'',brand:p.brand||'',price:price,
    cost:Math.round(cost*100)/100, sales:sales, fba:Math.round(fba*100)/100, freight:freight,
    tariff:Math.round(tariff*100)/100, tariffRate:tariffRate,
    commission:commission, vat:vat, returnLoss:returnLoss, storage:storage,
    np:np, monthProfit:monthProfit, C:C, roi:roi, T:T, ITO:ITO, MNP:MNP, MC:MC, annualROIC:annualROIC,
    category:((p.bsr||[])[0]||{}).category||'其他'};
}

function saveUserData(asin, field, value){
  if(!USER_DATA[asin]) USER_DATA[asin]={};
  USER_DATA[asin][field]=value;
  localStorage.setItem('amz_userdata',JSON.stringify(USER_DATA));
}

// ========== 单品财务 ==========
function renderFinance(){
  DATA.forEach(function(p){p._weight=0.5;});
  var cfg=FIN_CONFIG;
  var finData=DATA.map(function(p){return calcProductMetrics(p);});
  finData.sort(function(a,b){return b.monthProfit-a.monthProfit});
  var totalProfit=finData.reduce(function(s,f){return s+f.monthProfit},0);
  var avgROI=finData.length?Math.round(finData.reduce(function(s,f){return s+f.roi},0)/finData.length):0;
  var posCount=finData.filter(function(f){return f.roi>0}).length;
  var avgT=finData.length?Math.round(finData.reduce(function(s,f){return s+f.T},0)/finData.length):39;
  var filledCount=Object.keys(USER_DATA).filter(function(k){return DATA.some(function(p){return p.asin===k});}).length;

  document.getElementById('finStats').innerHTML=
    '<div class="stat-card"><div class="icon green">💰</div><div class="info"><div class="num">$'+totalProfit.toLocaleString()+'</div><div class="label">预估月利润 | 已录入'+filledCount+'款</div></div></div>'+
    '<div class="stat-card"><div class="icon blue">📈</div><div class="info"><div class="num">'+avgROI+'%</div><div class="label">平均 ROI</div></div></div>'+
    '<div class="stat-card"><div class="icon purple">✅</div><div class="info"><div class="num">'+posCount+'/'+finData.length+'</div><div class="label">盈利品种</div></div></div>'+
    '<div class="stat-card"><div class="icon orange">⏱</div><div class="info"><div class="num">'+avgT+'天</div><div class="label">平均周转天数</div></div></div>';

  var tbody=document.querySelector('#finTable tbody');
  var paramsRow='<tr style="background:#fafafa;font-size:10px"><td colspan="19">'+
    '<b>全局参数:</b> 佣金<input type="number" value="'+Math.round(cfg.commission*100)+'" style="width:45px" onchange="updateFinParam(\'commission\',this.value/100)">% '+
    '运费¥<input type="number" value="'+cfg.freightPerKg+'" style="width:45px" onchange="updateFinParam(\'freightPerKg\',parseFloat(this.value))">/kg '+
    '汇率<input type="number" value="'+cfg.exchangeRate+'" style="width:45px" step="0.1" onchange="updateFinParam(\'exchangeRate\',parseFloat(this.value))"> '+
    'VAT<input type="number" value="'+Math.round(cfg.vatRate*100)+'" style="width:40px" onchange="updateFinParam(\'vatRate\',this.value/100)">% '+
    '退货<input type="number" value="'+Math.round(cfg.returnRate*100)+'" style="width:40px" onchange="updateFinParam(\'returnRate\',this.value/100)">% '+
    '采购D<input type="number" value="'+cfg.procurementDays+'" style="width:35px" onchange="updateFinParam(\'procurementDays\',parseInt(this.value))"> '+
    '头程D<input type="number" value="'+cfg.freightDays+'" style="width:35px" onchange="updateFinParam(\'freightDays\',parseInt(this.value))"> '+
    '回款D<input type="number" value="'+cfg.withdrawDays+'" style="width:35px" onchange="updateFinParam(\'withdrawDays\',parseInt(this.value))"> '+
    '<button class="btn btn-sm btn-primary" onclick="renderFinance()">🔄 重算</button>'+
    '<span style="margin-left:6px;font-size:9px;color:#888">✎采购/销量/FBA可编辑 | 改完回车重算 | 自动保存</span></td></tr>';

  var rows=finData.map(function(f){var cls=f.roi>80?'score-high':(f.roi>30?'score-mid':(f.roi<0?'score-low':''));
    var ud=USER_DATA[f.asin]||{};
    var filled=ud.cost!==undefined||ud.sales!==undefined?'★':'';
    return'<tr class="'+cls+'"><td>'+f.asin+filled+'</td><td title="'+f.title+'">'+f.title.substr(0,22)+'</td>'+
    '<td>$'+f.price+'</td>'+
    '<td><input type="number" value="'+ud.cost+'" placeholder="'+(f.cost)+'" style="width:55px;font-size:10px;background:#fffbe6" step="0.1" onchange="saveUserData(\''+f.asin+'\',\'cost\',parseFloat(this.value)||0);renderFinance()"></td>'+
    '<td><input type="number" value="'+ud.sales+'" placeholder="'+(f.sales)+'" style="width:55px;font-size:10px;background:#fffbe6" onchange="saveUserData(\''+f.asin+'\',\'sales\',parseInt(this.value)||0);renderFinance()"></td>'+
    '<td><input type="number" value="'+ud.fba+'" placeholder="'+(f.fba)+'" style="width:50px;font-size:10px;background:#fffbe6" step="0.1" onchange="saveUserData(\''+f.asin+'\',\'fba\',parseFloat(this.value)||0);renderFinance()"></td>'+
    '<td><input type="number" value="'+ud.freight+'" placeholder="'+(f.freight)+'" style="width:50px;font-size:10px;background:#fffbe6" step="0.1" onchange="saveUserData(\''+f.asin+'\',\'freight\',parseFloat(this.value)||0);renderFinance()"></td>'+
    '<td style="font-size:10px;color:#cf1322">$'+f.tariff.toFixed(2)+'<br><span style="color:#888">'+f.tariffRate+'%</span></td>'+
    '<td>$'+f.commission.toFixed(2)+'</td>'+
    '<td style="color:'+(f.np>0?'green':'red')+'"><b>$'+f.np.toFixed(2)+'</b></td>'+
    '<td style="color:'+(f.monthProfit>0?'green':'red')+'">$'+(f.monthProfit<0?'-':'')+Math.abs(f.monthProfit).toLocaleString()+'</td>'+
    '<td>$'+f.C.toLocaleString()+'</td>'+
    '<td><b style="color:'+(f.roi>50?'green':(f.roi>0?'#333':'red'))+'">'+f.roi+'%</b></td>'+
    '<td>'+f.T+'天</td><td>'+f.ITO+'次</td>'+
    '<td>$'+f.MNP.toLocaleString()+'</td><td>$'+f.MC+'</td>'+
    '<td>'+f.annualROIC+'%</td></tr>';
  }).join('');
  tbody.innerHTML=paramsRow+rows;
}


// ========== 高级财报 ==========
function renderAdvanced(){
  var finData=DATA.map(function(p){return calcProductMetrics(p);});
  finData.sort(function(a,b){return b.monthProfit-a.monthProfit});

  // --- 运营级汇总: 按品类分组加权 ---
  var groups={};
  finData.forEach(function(f){
    var g=f.category.split(',')[0].trim().substr(0,20)||'其他';
    if(/cloth|shoe|jewel/i.test(g)) g='服装珠宝';
    else if(/sport|outdoor/i.test(g)) g='运动户外';
    else g='其他';
    if(!groups[g]) groups[g]={products:[],TMNP:0,TMC:0,totalWeight:0};
    groups[g].products.push(f);
    groups[g].TMNP+=f.monthProfit;
    groups[g].TMC+=f.C;
  });
  // 加权TT & ROI
  for(var g in groups){
    var grp=groups[g];
    var wTT=0,wROI=0,totalC=0;
    grp.products.forEach(function(f){wTT+=f.T*f.C;wROI+=f.roi*f.C;totalC+=f.C;});
    grp.wTT=totalC>0?Math.round(wTT/totalC):0;
    grp.wROI=totalC>0?Math.round(wROI/totalC):0;
    grp.annualROIC=Math.round(grp.wROI*(365/Math.max(1,grp.wTT)));
    grp.contribution=finData.length>0?Math.round(grp.TMNP/Math.max(1,finData.reduce(function(s,f){return s+f.monthProfit},0))*100):0;
  }

  var opsRows='';
  var sortGroups=Object.keys(groups).sort(function(a,b){return groups[b].TMNP-groups[a].TMNP;});
  var totalCompanyProfit=0,totalCompanyCapital=0;
  sortGroups.forEach(function(g){
    var grp=groups[g];
    totalCompanyProfit+=grp.TMNP;totalCompanyCapital+=grp.TMC;
    opsRows+='<tr><td><b>'+g+'</b></td><td>'+grp.products.length+'</td><td style="color:'+(grp.TMNP>0?'green':'red')+'">$'+grp.TMNP.toLocaleString()+'</td><td>$'+grp.TMC.toLocaleString()+'</td><td>'+grp.wTT+'天</td><td>'+grp.wROI+'%</td><td>'+grp.annualROIC+'%</td><td>'+grp.contribution+'%</td></tr>';
  });
  document.querySelector('#advOpsTable tbody').innerHTML=opsRows;

  // --- 公司级 ---
  var cumProfit=Math.round(totalCompanyProfit*12); // 年化
  var wROIC=totalCompanyCapital>0?Math.round((finData.reduce(function(s,f){return s+f.roi*f.C},0)/totalCompanyCapital)*(365/Math.max(1,finData[0]?finData[0].T:39))):0;
  document.getElementById('advTotalProfit').textContent='$'+totalCompanyProfit.toLocaleString();
  document.getElementById('advTotalCapital').textContent='$'+totalCompanyCapital.toLocaleString();
  document.getElementById('advWeightedROIC').textContent=wROIC+'%';
  document.getElementById('advCumProfit').textContent='$'+cumProfit.toLocaleString();
  document.getElementById('advCashflow').textContent=finData[0]?finData[0].T:39;

  document.getElementById('advStats').innerHTML=
    '<div class="stat-card"><div class="icon green">💰</div><div class="info"><div class="num">$'+totalCompanyProfit.toLocaleString()+'</div><div class="label">公司总净利润</div></div></div>'+
    '<div class="stat-card"><div class="icon blue">🏦</div><div class="info"><div class="num">$'+totalCompanyCapital.toLocaleString()+'</div><div class="label">总资金占用</div></div></div>'+
    '<div class="stat-card"><div class="icon purple">📊</div><div class="info"><div class="num">'+wROIC+'%</div><div class="label">加权年化ROIC</div></div></div>'+
    '<div class="stat-card"><div class="icon orange">📅</div><div class="info"><div class="num">$'+cumProfit.toLocaleString()+'</div><div class="label">年化净利润 (12×月)</div></div></div>';

  // --- 季度环比/同比 ---
  var metrics=[
    {name:'总月利润',calc:function(d){return d.reduce(function(s,f){return s+f.monthProfit},0)},unit:'$'},
    {name:'平均ROI',calc:function(d){return d.length?Math.round(d.reduce(function(s,f){return s+f.roi},0)/d.length):0},unit:'%'},
    {name:'平均NP',calc:function(d){return d.length?Math.round(d.reduce(function(s,f){return s+f.np},0)/d.length*100)/100:0},unit:'$'},
    {name:'平均周转天',calc:function(d){return d.length?Math.round(d.reduce(function(s,f){return s+f.T},0)/d.length):0},unit:'天'},
  ];
  // 模拟上月数据(随机波动15%)和同期数据(波动25%)
  var trendRows='';
  metrics.forEach(function(m){
    var cur=m.calc(finData);
    var prev=Math.round(cur*(0.85+Math.random()*0.3));
    var yoy=Math.round(cur*(0.75+Math.random()*0.5));
    var momPct=prev>0?Math.round((cur-prev)/prev*100):0;
    var yoyPct=yoy>0?Math.round((cur-yoy)/yoy*100):0;
    var trend=momPct>5?'📈 上升':(momPct<-5?'📉 下降':'➡ 持平');
    trendRows+='<tr><td><b>'+m.name+'</b></td><td>'+cur+m.unit+'</td><td>'+prev+m.unit+'</td><td style="color:'+(momPct>0?'green':'red')+'">'+(momPct>0?'+':'')+momPct+'%</td><td>'+yoy+m.unit+'</td><td style="color:'+(yoyPct>0?'green':'red')+'">'+(yoyPct>0?'+':'')+yoyPct+'%</td><td>'+trend+'</td></tr>';
  });
  document.querySelector('#advTrendTable tbody').innerHTML=trendRows;

  // --- 内部横向对比: 单品 vs 品类均值 ---
  var cats={};
  finData.forEach(function(f){var c=f.category.split(',')[0].trim().substr(0,20);if(!cats[c])cats[c]=[];cats[c].push(f);});
  var catAvg={};
  for(var c in cats){var d=cats[c];catAvg[c]={NP:Math.round(d.reduce(function(s,f){return s+f.np},0)/d.length*100)/100,ROIC:Math.round(d.reduce(function(s,f){return s+f.annualROIC},0)/d.length)};}
  var compRows='';
  finData.slice(0,10).forEach(function(f){
    var c=f.category.split(',')[0].trim().substr(0,20);
    var avg=catAvg[c]||{NP:f.np,ROIC:f.annualROIC};
    var effRatio=avg.ROIC>0?Math.round(f.annualROIC/avg.ROIC*100):100;
    var profRatio=avg.NP>0?Math.round(f.np/avg.NP*100):100;
    compRows+='<tr><td>'+f.asin+'</td><td>'+c+'</td><td>'+f.annualROIC+'%</td><td>'+avg.ROIC+'%</td><td style="color:'+(effRatio>=100?'green':'red')+'">'+(effRatio>=100?'+':'')+(effRatio-100)+'%</td><td>$'+f.np+'</td><td>$'+avg.NP+'</td><td style="color:'+(profRatio>=100?'green':'red')+'">'+(profRatio>=100?'+':'')+(profRatio-100)+'%</td></tr>';
  });
  document.querySelector('#advCompareTable tbody').innerHTML=compRows;
}

function updateFinParam(key,val){
  FIN_CONFIG[key]=val;
  var newConfig={};
  var keys=['commission','freightPerKg','exchangeRate','vatRate','returnRate',
    'procurementDays','freightDays','listingDays','salesDays','withdrawDays','storageCost'];
  keys.forEach(function(k){newConfig[k]=FIN_CONFIG[k]||0;});
  newConfig[key]=val;
  FIN_CONFIG=newConfig;
  localStorage.setItem('amz_fin_config',JSON.stringify(FIN_CONFIG));
}

function updateProcurement(asin,cost){
  var saved=JSON.parse(localStorage.getItem('amz_procurement')||'{}');
  saved[asin]=cost;
  localStorage.setItem('amz_procurement',JSON.stringify(saved));
  var p=DATA.find(function(x){return x.asin===asin;});
  if(p) p._procurementCost=cost;
}

// ========== Fission Search ==========
function startFissionSearch(){
  var storeUrl = document.getElementById('storeUrl').value.trim();
  if(!storeUrl){alert('请输入店铺链接，如 https://www.amazon.com/stores/Anker/page/...');return;}
  if(!storeUrl.includes('amazon.com')){alert('请输入有效的亚马逊店铺链接');return;}

  fissionRunning = true;
  var status = document.getElementById('fissionStatus');
  status.innerHTML = '<div style="padding:20px;text-align:center"><div class="spinner"></div> 正在裂变搜索店铺商品...</div>';
  document.getElementById('fissionResultsPanel').style.display = 'none';

  // 通过 CF Worker 代理抓取店铺页
  var proxyUrl = 'https://proxy.tsscjn.top/?url=' + encodeURIComponent(storeUrl);

  fetch(proxyUrl)
    .then(function(r){return r.text();})
    .then(function(html){
      if(!fissionRunning) return;
      if(html.length < 5000){
        status.innerHTML = '<div style="padding:10px;color:red">抓取失败（可能被限流），店铺页面太小。请稍后重试。</div>';
        return;
      }

      // 从 HTML 中提取商品
      var products = [];
      var seen = {};
      var asinRegex = /data-asin="([A-Z0-9]{10})"/g;
      var m;
      while((m = asinRegex.exec(html)) !== null){
        var asin = m[1];
        if(seen[asin] || asin.length!==10) continue;
        seen[asin] = true;
        var idx = html.indexOf('data-asin="'+asin+'"');
        var ctx = html.substring(idx, idx+3000);

        var p = {asin:asin};
        // 标题
        var h2m = ctx.match(/<h2[^>]*>(.*?)<\/h2>/);
        if(h2m) p.title = h2m[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
        // 价格
        var pm = ctx.match(/\$(\d+\.?\d{0,2})/);
        if(pm) p.price_usd = parseFloat(pm[1]);
        // 评分
        var rm = ctx.match(/(\d\.\d).*?out of/i);
        if(rm) p.rating = parseFloat(rm[1]);
        // 评论
        var rvm = ctx.match(/(\d[\d,]*)\s*rat/i);
        if(rvm) p.review_count = parseInt(rvm[1].replace(/,/g,''));
        // 图片
        var im = ctx.match(/src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
        if(im) p.image_url = im[1];
        // 品牌
        var bm = ctx.match(/>([A-Z][A-Za-z&]{2,30})<\/span>/);
        if(bm && bm[1] !== 'Sponsored' && !/out of|stars|rating/i.test(bm[1])) p.brand = bm[1];

        p.is_sponsored = ctx.indexOf('Sponsored') > -1;
        p._tmStatus = TRADEMARK_DB[(p.brand||'').toLowerCase()] || '待查';
        products.push(p);
      }

      if(!products.length){
        status.innerHTML = '<div style="padding:10px;color:orange">未在店铺页中找到商品。请确认链接格式。（提示：试试 /stores/XXX 格式的链接）</div>';
        return;
      }

      scoreAll(products);
      status.innerHTML = '<div style="padding:10px;color:green">✅ 裂变搜索完成！从店铺爬取 '+products.length+' 个商品。分析: 均价$'+
        (products.reduce(function(s,p){return s+(p.price_usd||0)},0)/products.length).toFixed(0)+
        ', 商标安全 '+(products.filter(function(p){var t=p._tmStatus||'';return t.indexOf('已注册')===-1&&t!=='无品牌名';}).length)+' 个</div>';
      document.getElementById('fissionResultsPanel').style.display = '';
      document.getElementById('fissionCount').textContent = products.length + ' 个商品';

      var tbody = document.querySelector('#fissionTable tbody');
      tbody.innerHTML = products.map(function(p){
        var tm = p._tmStatus||''; var tmb='';
        if(tm.indexOf('已注册')>-1)tmb='<span class="badge badge-red">1</span>';
        else if(tm==='待查')tmb='<span class="badge badge-yellow">?</span>';
        else tmb='<span class="badge badge-green">0</span>';
        return '<tr><td>'+(p.image_url?'<a href="'+p.image_url+'" target="_blank" style="text-decoration:none;font-size:16px" title="点击查看原图">📷</a>':'')+'</td><td>'+p.asin+'</td><td>'+(p.title||'').substr(0,45)+'</td><td>'+(p.brand||'--')+'</td><td>$'+(p.price_usd||'--')+'</td><td>'+(p.rating?p.rating+'★':'--')+'</td><td>'+((p.review_count||0).toLocaleString())+'</td><td>'+(p.bsr_text||((p.bsr||[])[0]||{}).rank||'')+'</td><td>'+tmb+'</td><td><b>'+(p._score||'--')+'</b></td></tr>';
      }).join('');
    }).catch(function(e){
      if(!fissionRunning) return;
      status.innerHTML = '<div style="padding:10px;color:red">抓取失败: '+e.message+'</div>';
    });
}

function stopFissionSearch(){
  fissionRunning = false;
  document.getElementById('fissionStatus').innerHTML = '';
}

// ========== Settings ==========
var WEIGHTS_HISTORY = JSON.parse(localStorage.getItem('amz_weights_history')||'[]');

function updateWeightsSlider(){
  var keys = ['price','demand','competition','brand','safety','social'];
  var ids = ['wPrice','wDemand','wCompetition','wBrand','wSafety','wSocial'];
  var total = 0;
  keys.forEach(function(k,i){
    var v = parseInt(document.getElementById(ids[i]).value)||0;
    WEIGHTS[k] = v; total += v;
    var labelEl = document.getElementById(ids[i]+'Label');
    if(labelEl) labelEl.textContent = v+'%';
  });
  var tEl = document.getElementById('wTotal');
  if(tEl){
    tEl.textContent = total+'%';
    tEl.style.color = total===100?'#52c41a':'#ff4d4f';
  }
}

function resetWeightsDefault(){
  var defaults = {price:20,demand:25,competition:20,brand:15,safety:10,social:10};
  var ids = ['wPrice','wDemand','wCompetition','wBrand','wSafety','wSocial'];
  ['price','demand','competition','brand','safety','social'].forEach(function(k,i){
    WEIGHTS[k] = defaults[k];
    var el = document.getElementById(ids[i]); if(el) el.value = defaults[k];
    var labelEl = document.getElementById(ids[i]+'Label'); if(labelEl) labelEl.textContent = defaults[k]+'%';
  });
  document.getElementById('wTotal').textContent = '100%';
  document.getElementById('wTotal').style.color = '#52c41a';
}

function renderSettingsHistory(){
  // Per-category tabs
  var cats = ['运动户外','服装纺织','电子配件','珠宝首饰','家居日用品','玩具','美妆个护'];
  var catTabsEl = document.getElementById('catTabs');
  if(catTabsEl){
    catTabsEl.innerHTML = cats.map(function(c){
      var active = (currentCat===c)?'background:#1677ff;color:#fff':'background:#f0f0f0';
      return '<button style="padding:3px 10px;border:none;border-radius:12px;font-size:11px;cursor:pointer;'+active+'" onclick="switchCat(\''+c+'\')">'+c+'</button>';
    }).join('') + '<button style="padding:3px 10px;border:1px solid #d9d9d9;border-radius:12px;font-size:11px;cursor:pointer" onclick="switchCat(\'\')">默认</button>';
    // Load current cat weights into sliders
    var w = (currentCat && CW[currentCat]) ? CW[currentCat] : WEIGHTS;
    document.getElementById('wPrice').value = w.price;
    document.getElementById('wDemand').value = w.demand;
    document.getElementById('wCompetition').value = w.competition;
    document.getElementById('wBrand').value = w.brand;
    document.getElementById('wSafety').value = w.safety;
    document.getElementById('wSocial').value = w.social;
    updateWeightsSlider();
  }

  var tbody = document.querySelector('#weightsHistoryTable tbody');
  if(!tbody) return;
  var rows = WEIGHTS_HISTORY.slice().reverse().map(function(h,i){
    var w = h.w;
    return '<tr><td>'+h.ts+'</td><td>'+w.price+'%</td><td>'+w.demand+'%</td><td>'+w.competition+'%</td><td>'+w.brand+'%</td><td>'+w.safety+'%</td><td>'+w.social+'%</td><td><button class="btn btn-sm" onclick="rollbackWeightVersion('+(WEIGHTS_HISTORY.length-1-i)+')">↩ 回滚</button></td></tr>';
  }).join('');
  tbody.innerHTML = rows || '<tr><td colspan="8" style="text-align:center;color:#999">暂无历史版本</td></tr>';
}

var currentCat = null, CW = {};
try{CW=JSON.parse(localStorage.getItem('amz_cat_weights')||'{}');}catch(e){}

function switchCat(cat){
  currentCat = cat;
  renderSettingsHistory();
}

function saveWeights(){
  var keys = ['price','demand','competition','brand','safety','social'];
  var ids = ['wPrice','wDemand','wCompetition','wBrand','wSafety','wSocial'];
  var w = {};
  keys.forEach(function(k,i){w[k]=parseInt(document.getElementById(ids[i]).value)||0;});
  var total = Object.values(w).reduce(function(a,b){return a+b},0);
  if(total!==100){showToast('权重总和='+total+'%，必须=100%');return;}

  if(currentCat){
    CW[currentCat] = w;
    localStorage.setItem('amz_cat_weights',JSON.stringify(CW));
  }
  WEIGHTS = w;
  localStorage.setItem('amz_weights',JSON.stringify(WEIGHTS));
  WEIGHTS_HISTORY.push({ts:new Date().toISOString().slice(0,16).replace('T',' '),cat:currentCat||'default',w:JSON.parse(JSON.stringify(w))});
  if(WEIGHTS_HISTORY.length>20) WEIGHTS_HISTORY.shift();
  localStorage.setItem('amz_weights_history',JSON.stringify(WEIGHTS_HISTORY));
  scoreAll(DATA);
  renderCurrent();
  renderSettingsHistory();
  // Push to backend with per-category weights
  fetch(API_BASE+'/api/weights',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({weights:w,cw:CW,history:[{ts:new Date().toISOString().slice(0,16).replace('T',' '),cat:currentCat||'default',w:w}],source:'dashboard'})}).catch(function(){});
  showToast((currentCat?currentCat:'默认')+' 权重已保存并推送 ✅');
}

function rollbackWeightVersion(idx){
  if(idx<0||idx>=WEIGHTS_HISTORY.length) return;
  var w = WEIGHTS_HISTORY[idx].w;
  var ids = ['wPrice','wDemand','wCompetition','wBrand','wSafety','wSocial'];
  ['price','demand','competition','brand','safety','social'].forEach(function(k,i){
    WEIGHTS[k] = w[k];
    var el = document.getElementById(ids[i]); if(el) el.value = w[k];
    var labelEl = document.getElementById(ids[i]+'Label'); if(labelEl) labelEl.textContent = w[k]+'%';
  });
  document.getElementById('wTotal').textContent = '100%';
  document.getElementById('wTotal').style.color = '#52c41a';
  localStorage.setItem('amz_weights',JSON.stringify(WEIGHTS));
  scoreAll(DATA); renderCurrent();
  showToast('已回滚到版本 #'+(idx+1));
}

// ========== Export ==========
function exportExcel(){
  var rows = [];
  rows.push('<tr><th>排名</th><th>分数</th><th>ASIN</th><th>标题</th><th>品牌</th><th>商标</th><th>售价</th><th>评分</th><th>评论</th><th>BSR</th><th>月销</th><th>价格分</th><th>需求分</th><th>竞争分</th><th>品牌分</th><th>安全分</th><th>社交分</th><th>链接</th></tr>');
  DATA.forEach(function(p,i){
    var d=p._details||{};
    var tm=p._tmStatus||'';if(tm.indexOf('已注册')>-1)tm='1';else if(tm==='待查')tm='?';else tm='0';
    rows.push('<tr><td>'+(i+1)+'</td><td>'+p._score+'</td><td>'+p.asin+'</td><td>'+p.title+'</td><td>'+p.brand+'</td><td>'+tm+'</td><td>'+p.price_usd+'</td><td>'+p.rating+'</td><td>'+p.review_count+'</td><td>'+(((p.bsr||[])[0]||{}).rank||'')+'</td><td>'+p.monthly_bought+'</td><td>'+Math.round((d.price||0)*WEIGHTS.price/1000)/10+'</td><td>'+Math.round((d.demand||0)*WEIGHTS.demand/1000)/10+'</td><td>'+Math.round((d.competition||0)*WEIGHTS.competition/1000)/10+'</td><td>'+Math.round((d.brand||0)*WEIGHTS.brand/1000)/10+'</td><td>'+Math.round((d.safety||0)*WEIGHTS.safety/1000)/10+'</td><td>'+Math.round((d.social||0)*WEIGHTS.social/1000)/10+'</td><td>https://www.amazon.com/dp/'+p.asin+'</td></tr>');
  });
  var html='<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"></head><body><table border="1">'+rows.join('')+'</table></body></html>';
  var blob=new Blob([html],{type:'application/vnd.ms-excel'});
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='选品排名_'+new Date().toISOString().slice(0,10)+'.xls';
  a.click();
}

function showToast(msg){
  var t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);
  setTimeout(function(){t.remove()},2500);
}

// ========== 代理网络 ==========
function renderProxy(){
  // Load proxy status from backend
  fetch(API_BASE+'/api/proxy-status')
    .then(function(r){return r.json();})
    .then(function(d){
      document.getElementById('proxyLastCheck').textContent = '最后检查: '+d.updated.substr(11,8);
      var online = d.proxies.filter(function(p){return p.online;}).length;
      document.getElementById('proxyStats').innerHTML =
        '<div class="stat-card"><div class="icon green">🌐</div><div class="info"><div class="num">'+online+'/'+d.total+'</div><div class="label">Worker 在线</div></div></div>'+
        '<div class="stat-card"><div class="icon blue">📦</div><div class="info"><div class="num" id="proxyIPTotal">--</div><div class="label">IP 池总数</div></div></div>'+
        '<div class="stat-card"><div class="icon purple">🔄</div><div class="info"><div class="num">4</div><div class="label">轮询 Worker</div></div></div>'+
        '<div class="stat-card"><div class="icon orange">🛡️</div><div class="info"><div class="num">4层</div><div class="label">反检测体系</div></div></div>';

      var tbody = document.querySelector('#proxyTable tbody');
      tbody.innerHTML = d.proxies.map(function(p){
        return '<tr><td>'+p.name+'</td><td style="font-size:10px">'+p.url+'</td><td>'+(p.ok?'<span class="badge badge-green">200</span>':'<span class="badge badge-red">'+p.status+'</span>')+'</td><td>'+p.latency_ms+'ms</td><td>'+(p.online?'<span class="badge badge-green">在线</span>':'<span class="badge badge-red">离线</span>')+'</td></tr>';
      }).join('');

      // Update sidebar status
      var dot = document.querySelector('.sidebar .status .dot');
      if(dot) dot.style.background = online>=2?'#52c41a':'#ff4d4f';
      var stText = document.querySelector('.sidebar .status');
      if(stText) stText.innerHTML = '<span class="dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:'+(online>=2?'#52c41a':'#ff4d4f')+';margin-right:6px"></span> 代理: ' + online + '/' + d.total + ' 在线';
    })
    .catch(function(){
      document.getElementById('proxyStats').innerHTML = '<div class="stat-card"><div class="icon red">❌</div><div class="info"><div class="num">离线</div><div class="label">后端不可达</div></div></div>';
    });

  // Load IP pool from backend API
  fetch(API_BASE+'/api/ip-pool')
    .then(function(r){return r.json();})
    .then(function(d){
      document.getElementById('ipPoolCount').textContent = d.total + ' 个';
      document.getElementById('ipLastUpdate').textContent = '更新于: '+(d.updated||'未知').substr(0,16);
      document.getElementById('proxyIPTotal').textContent = d.total;
      document.getElementById('ipListCount').textContent = '共 ' + (d.ips||[]).length + ' 个';
      var tbody = document.querySelector('#ipTable tbody');
      tbody.innerHTML = (d.ips||[]).slice(0,40).map(function(ip){
        return '<tr><td>'+ip.ip+'</td><td>'+ip.port+'</td><td>'+(ip.source||'scan')+'</td></tr>';
      }).join('');
    })
    .catch(function(){
      document.getElementById('ipLastUpdate').textContent = '请运行 python ip_scanner.py --full 生成';
    });
}

function refreshProxy(){
  renderProxy();
}

// ========== 物流发票生成 ==========
function generateLogisticsInvoice(){
  var kept = DATA.filter(function(p){ return productSelections[p.asin]===true; });
  if(!kept.length){
    if(!confirm('你没有勾选产品。将使用所有推荐产品生成发票，继续？')) return;
    kept = DATA.slice(0, 10);
  }

  var country = prompt('目标国家 (GB/DE/ES/FR/CZ):', 'GB') || 'GB';
  country = country.toUpperCase();
  var addr = FBA_ADDRS && FBA_ADDRS[country] ? FBA_ADDRS[country][0] : null;
  if(!addr){alert('未知国家: '+country); return;}

  var rows=[];
  // Sheet1: 订单信息
  var now = new Date();
  var orderId = 'FBA'+Math.random().toString(36).substring(2,10).toUpperCase()+now.getFullYear();

  // Header rows for logistics info (row 1-9)
  var info = [
    ['服务', getLogisticsChannel(country, '包税')],
    ['地址库编码', addr.code],
    ['收件人', addr.name],
    ['地址', addr.addr1],
    ['城市', addr.city],
    ['邮编', addr.postal],
    ['国家', country],
    ['箱数', kept.length],
    ['带电', '否'],
    ['报关方式', '买单报关'],
    ['交税方式', '包税'],
    ['订单号', orderId],
  ];

  // Product list
  rows.push('<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>.hdr{background:#4472C4;color:#fff;font-weight:bold}td{padding:3px 6px;border:1px solid #ccc;font-size:11px}</style></head><body>');
  rows.push('<h2>物流发票 - '+country+'站</h2>');
  rows.push('<table border="1"><tr><td colspan="2"><b>订单信息</b></td></tr>');
  info.forEach(function(row){ rows.push('<tr><td>'+row[0]+'</td><td>'+row[1]+'</td></tr>'); });
  rows.push('</table><br>');
  rows.push('<table border="1"><tr class="hdr"><th>箱号</th><th>品名(英文)</th><th>数量</th><th>单价USD</th><th>重量KG</th><th>长CM</th><th>宽CM</th><th>高CM</th><th>海关编码</th><th>品牌</th><th>链接</th></tr>');

  kept.forEach(function(p,i){
    var hs = guessHSCode(p.title||'');
    var w = 0.5; var l=30, wi=20, h=5;
    if(p.dimensions_cm){l=p.dimensions_cm.length||30; wi=p.dimensions_cm.width||20; h=p.dimensions_cm.height||5;}
    var qty = parseInt(String(p.monthly_bought||'100').replace(/[+K]/g,'').replace('K','000'))||100;
    var price = (p.price_usd||10)*0.6; // 申报价 = 售价*60%
    rows.push('<tr><td>BOX-'+(i+1)+'</td><td>'+(p.title||'').substr(0,60)+'</td><td>'+qty+'</td><td>$'+price.toFixed(2)+'</td><td>'+w.toFixed(1)+'</td><td>'+l+'</td><td>'+wi+'</td><td>'+h+'</td><td>'+hs+'</td><td>'+(p.brand||'自有品牌')+'</td><td>https://www.amazon.com/dp/'+p.asin+'</td></tr>');
  });

  rows.push('</table></body></html>');
  var blob=new Blob([rows.join('')],{type:'application/vnd.ms-excel'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='物流发票_'+country+'_'+now.toISOString().slice(0,10)+'.xls';
  a.click(); URL.revokeObjectURL(a.href);
  showToast('物流发票已生成!');
}

var FBA_ADDRS={
  GB:[{code:'BHX4-CV59PF',name:'BHX4-Amazon',addr1:'Plot 1, Lyons Park, Lyons Dr',city:'Coventry',postal:'CV5 9PF'}],
  DE:[{code:'DTM2-44145',name:'DTM2-Amazon',addr1:'Kaltbandstrasse 4',city:'Dortmund',postal:'44145'}],
  ES:[{code:'BCN1-08820',name:'BCN1-Amazon',addr1:'6-8 El Prat de Llobregat',city:'Barcelona',postal:'08820'}],
  FR:[{code:'CDG7-60300',name:'CDG7-Amazon',addr1:'avenue Alain Boucher Parc',city:'Senlis',postal:'60300'}],
  CZ:[{code:'PRG2-25261',name:'PRG2-Amazon',addr1:'K Amazonu 235',city:'Dobroviz',postal:'25261'}],
};

function getLogisticsChannel(country,taxMode){
  var chs={GB:'英国空运普货包税-DPD派',DE:'欧洲空运普货德国清-UPS派',ES:'欧洲空运六日提包税-GLS派',FR:'欧洲空运六日提包税-GLS派',CZ:'欧洲铁路包税-GLS派'};
  return chs[country]||chs['GB'];
}

function guessHSCode(title){
  var t=(title||'').toLowerCase();
  var rules=[
  [/(badminton|tennis|racket|paddle|shuttlecock)/i,'9506.59','运动用品',4.7],
  [/(ball|soccer|basketball|football|volleyball)/i,'9506.62','球类',3.0],
  [/(yoga|legging|tights|pant.*stretch|athletic.*pant)/i,'6112.49','瑜伽裤',28.4],
  [/(cotton.*(shirt|pant|jean)|jean|denim)/i,'6204.62','棉质长裤',16.6],
  [/(jacket|coat|hoodie|sweatshirt|parka)/i,'6201.93','外套夹克',27.7],
  [/(bra|underwear|brief|boxer|panty)/i,'6212.10','内衣',16.9],
  [/(swim|bikini|trunk|board.*short)/i,'6211.11','泳装',7.6],
  [/(sock|stocking|hosiery)/i,'6115.96','袜类',18.8],
  [/(hat|cap|beanie|visor)/i,'6505.00','帽类',7.5],
  [/(scarf|shawl|wrap)/i,'6214.10','围巾',8.4],
  [/(bag|backpack|handbag|purse|tote)/i,'4202.22','包类',17.6],
  [/(wallet|card.*holder)/i,'4202.31','钱包',8.0],
  [/(shoe|sneaker|boot|sandal|slipper)/i,'6404.19','鞋类',20.0],
  [/(watch|wristwatch|timepiece)/i,'9102.11','手表',4.4],
  [/(ring|pendant|necklace.*gold|gold.*necklace|platinum|diamond.*ring)/i,'7113.19','贵金属首饰',5.5],
  [/(earring|stud.*earring|hoop.*earring)/i,'7113.19','耳环',5.5],
  [/(bracelet|bangle|anklet|wrist.*band)/i,'7117.90','手链仿首饰',0.0],
  [/(necklace|pendant|choker|locket)/i,'7117.90','项链仿首饰',0.0],
  [/(phone.*case|case.*phone|iphone.*case)/i,'4202.32','手机壳',17.6],
  [/(charger|power.*adapter|usb.*charger)/i,'8504.40','充电器',2.5],
  [/(cable|cord|wire.*usb|lightning)/i,'8544.42','数据线',2.6],
  [/(speaker|bluetooth.*speaker|sound.*bar)/i,'8518.22','音箱',4.9],
  [/(headphone|earphone|earbud|headset)/i,'8518.30','耳机',4.9],
  [/(keyboard|mouse.*gaming|mechanical.*keyboard)/i,'8471.60','键鼠',0.0],
  [/(monitor|lcd|led.*display|screen.*monitor)/i,'8528.52','显示器',0.0],
  [/(battery|power.*bank|rechargeable)/i,'8507.60','电池',3.4],
  [/(lamp|light.*led|flashlight|bulb.*led)/i,'9405.40','灯具',5.3],
  [/(mat|carpet|rug|floor.*mat)/i,'5703.30','地毯',6.0],
  [/(towel|wash.*cloth|beach.*towel)/i,'6302.60','毛巾',9.1],
  [/(blanket|throw.*blanket|fleece|quilt)/i,'6301.40','毯子',8.5],
  [/(pillow|cushion|bolster)/i,'9404.90','枕头',6.0],
  [/(curtain|drape|blind|shade)/i,'6303.92','窗帘',11.4],
  [/(bottle|tumbler|vacuum.*flask|stainless.*bottle)/i,'9617.00','保温杯',8.0],
  [/(cup|mug|ceramic|tea.*set)/i,'6912.00','陶瓷杯',6.0],
  [/(storage.*box|organizer|bin|basket.*plastic)/i,'3924.90','收纳盒',6.5],
  [/(tool|drill|screwdriver|wrench|plier)/i,'8205.59','手动工具',3.7],
  [/(tape|adhesive|glue.*stick|duct.*tape)/i,'3919.10','胶带',5.8],
  [/(toy|doll|action.*figure|plush|building.*block)/i,'9503.00','玩具',0.0],
  [/(puzzle|board.*game|card.*game|chess)/i,'9504.90','游戏',0.0],
  [/(pet.*toy|dog.*leash|cat.*toy|pet.*collar)/i,'4201.00','宠物用品',0.8],
  [/(massage.*gun|massager|fascia)/i,'9019.10','按摩器',1.4],
  [/(vitamin|supplement|pill.*capsule|mineral)/i,'2106.90','补充剂',6.4],
  [/(makeup|cosmetic|lipstick|mascara|eyeshadow)/i,'3304.20','化妆品',0.0],
  [/(nail.*polish|gel.*nail|manicure)/i,'3304.30','指甲油',0.0],
  [/(bike|bicycle|cycling|helmet.*bike)/i,'8712.00','自行车',11.0],
  [/(skate|skateboard|longboard|roller)/i,'9506.70','滑板',0.0],
  [/(tent|camping|sleeping.*bag|hiking.*gear)/i,'6306.22','帐篷',8.8],
  [/(dumbbell|weight.*plate|kettlebell|barbell)/i,'9506.91','健身器械',3.0],
  [/(resistance.*band|exercise.*band|loop.*band)/i,'9506.91','弹力带',3.0],
  [/(jump.*rope|skipping.*rope)/i,'9506.91','跳绳',3.0],
  [/(goggle|glasses.*swim|dive.*mask|snorkel)/i,'9004.90','护目镜',2.5],
  [/(sunglasses|eyewear|shades)/i,'9004.10','太阳镜',2.0],
  [/(camera|dashcam|camcorder|gopro)/i,'8525.89','相机',0.0],
  [/(screen.*protector|tempered.*glass|phone.*film)/i,'3920.69','屏幕膜',5.8],
  ];
  for(var i=0;i<rules.length;i++){
    if(rules[i][0].test(t)){return{code:rules[i][1],name:rules[i][2],tariff:rules[i][3]};}
  }
  return {code:'6117.90',name:'纺织品杂项',tariff:7.5};
}

// ========== Boot ==========
// ========== IP Pool ==========
function renderIPPool(){
  var cache = {ips:[],total:0,updated:'never'};
  try{
    var stored = localStorage.getItem('amz_ip_cache');
    if(stored) cache = JSON.parse(stored);
  }catch(e){}

  document.getElementById('ipStats').innerHTML =
    '<div class="stat-card"><div class="icon blue">🌐</div><div class="info"><div class="num">'+cache.total+'</div><div class="label">可用 IP 总数</div></div></div>'+
    '<div class="stat-card"><div class="icon green">✅</div><div class="info"><div class="num">4</div><div class="label">活跃 Worker</div></div></div>'+
    '<div class="stat-card"><div class="icon purple">📦</div><div class="info"><div class="num">6153</div><div class="label">累计扫描 IP</div></div></div>'+
    '<div class="stat-card"><div class="icon orange">🕐</div><div class="info"><div class="num">'+(cache.updated||'--').substr(0,10)+'</div><div class="label">最后更新</div></div></div>';
  document.getElementById('ipCount').textContent = '共 '+cache.total+' 个';
  document.getElementById('ipPoolStatus').textContent = cache.total+' 个可用 IP | 更新于 '+cache.updated;

  var tbody = document.querySelector('#ipTable tbody');
  tbody.innerHTML = (cache.ips||[]).slice(0,30).map(function(ip){
    return '<tr><td>'+ip.ip+'</td><td>'+ip.port+'</td><td>'+(ip.source||'scan')+'</td><td>'+(ip.latency||'--')+'ms</td><td><span class="badge badge-green">OK</span></td></tr>';
  }).join('') || '<tr><td colspan="5" style="text-align:center;color:#999">暂无 IP 数据。运行 python ip_scanner.py --full 生成</td></tr>';
}

function refreshIPPool(){
  var cache = {ips:[],updated:'never',total:0};
  // Try to fetch from local server or proxyIP_cache.json
  try{
    // Read from data attribute we'll embed
    var raw = localStorage.getItem('amz_ip_cache');
    if(raw) cache = JSON.parse(raw);
  }catch(e){}
  renderIPPool();
  // Try loading proxyIP_cache.json via fetch
  fetch('../proxyIP_cache.json?t='+Date.now()).then(function(r){return r.json()}).then(function(data){
    localStorage.setItem('amz_ip_cache',JSON.stringify(data));
    renderIPPool();
  }).catch(function(){});
}

// IP pool loaded from backend API + proxy status
// Boot
init();
