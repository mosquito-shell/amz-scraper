"""
亚马逊跟卖选品打分引擎
基于 PRD 规则: 价格分 + 需求分 + 竞争分 + 品牌分 + 安全分
权重可调，每次调整自动保存历史版本
"""
import json
import os
from datetime import datetime

# ============================================================
# 默认权重（可调整）
# ============================================================
DEFAULT_WEIGHTS = {
    "price": 20,       # 价格分权重
    "demand": 25,      # 需求分权重 (BSR)
    "competition": 20, # 竞争分权重 (评论数)
    "brand": 15,       # 品牌分权重
    "safety": 10,      # 安全分权重 (非广告/非Generic)
    "social": 10,      # 社交证明 (评分)
}

# ============================================================
# 各维度评分函数（0-100）
# ============================================================

def score_price(price_usd):
    """价格评分: $12-40 最优区间 (利润率 + 下单门槛低)
       <$8: 利润太低 → 30分
       $8-12: 偏低 → 60分
       $12-25: 黄金区间 → 95分
       $25-40: 良好 → 85分
       $40-70: 偏高 → 60分
       $70-120: 高 → 40分
       >$120: 太高 → 15分
    """
    if price_usd is None:
        return 50
    if price_usd < 6:   return 15
    if price_usd < 12:  return 60
    if price_usd <= 25: return 95
    if price_usd <= 40: return 85
    if price_usd <= 70: return 60
    if price_usd <= 120: return 40
    return 15


def score_demand(bsr_list, review_count=0, monthly_bought=""):
    """需求评分: BSR 越低=卖得越好=需求越大
       主BSR < 500: 爆款 → 98分
       < 2000: 热销 → 90分
       < 5000: 好卖 → 80分
       < 10000: 不错 → 65分
       < 50000: 一般 → 40分
       < 100000: 冷门 → 20分
       >= 100000: 滞销 → 5分
       无BSR: 用月销量推算
    """
    if not bsr_list or not bsr_list[0].get("rank"):
        # 用月销量兜底
        if monthly_bought:
            mb = monthly_bought.replace("+", "").replace("K", "000")
            try:
                n = int(mb)
                if n >= 5000: return 90
                if n >= 1000: return 75
                if n >= 500:  return 60
                if n >= 100:  return 40
                return 25
            except: pass
        return 30

    try:
        bsr = int(bsr_list[0]["rank"].replace(",", ""))
    except:
        return 30

    if bsr < 500:     return 98
    if bsr < 2000:    return 90
    if bsr < 5000:    return 80
    if bsr < 10000:   return 65
    if bsr < 30000:   return 45
    if bsr < 50000:   return 30
    if bsr < 100000:  return 15
    return 5


def score_competition(review_count):
    """竞争评分: 评论数反映市场竞争程度
       0-30: 新品/蓝海 → 90分 (竞争小，机会大)
       30-100: 成长期 → 85分
       100-500: 成长中，仍有空间 → 80分
       500-2000: 有一定竞争 → 60分
       2000-5000: 竞争激烈 → 40分
       5000-15000: 红海 → 20分
       >15000: 血海 → 5分
    """
    if review_count is None:
        return 50
    if review_count < 30:    return 90
    if review_count < 100:   return 85
    if review_count < 500:   return 80
    if review_count < 2000:  return 60
    if review_count < 5000:  return 40
    if review_count < 15000: return 20
    return 5


def score_brand(brand_name):
    """品牌评分: 知名品牌 > 小众品牌 > 无品牌
       Generic/空 = 罚分（跟卖容易撞车）
    """
    if not brand_name or brand_name in ("Generic", "From the Author", "N/A", ""):
        return 30
    # 大牌加分
    TOP_BRANDS = {
        "YONEX", "Yonex", "Anker", "Swarovski", "Bose", "Sony",
        "JBL", "Samsung", "Apple", "Baden", "Franklin Sports",
        "CRZ YOGA", "PANDORA", "Kendra Scott", "PAVOI",
    }
    if brand_name in TOP_BRANDS:
        return 90
    # 有品牌名就及格
    return 70


def score_safety(product):
    """安全性: 广告品 + Generic = 风险高
       非广告 + 有品牌 + 无敏感词 → 高分
    """
    score = 50
    if not product.get("is_sponsored"):
        score += 25
    brand = product.get("brand", "")
    if brand and brand not in ("Generic", "From the Author"):
        score += 15
    title = product.get("title", "").lower()
    bad_words = ["replacement", "compatible", "knockoff", "refurbished", "used"]
    if any(w in title for w in bad_words):
        score -= 20
    return max(0, min(100, score))


def score_social(rating, review_count):
    """社交证明: 评分 + 评论数 综合
       4.5+ 好评 + 有一定评论量 = 产品靠谱
    """
    if rating is None:
        return 40
    s = rating * 15
    if review_count and review_count > 100:
        s += 10
    if review_count and review_count > 1000:
        s += 10
    return min(100, s)


# ============================================================
# 综合打分
# ============================================================

def score_product(product, weights=None):
    """对单个商品打分，返回(总分, 各维度明细)"""
    if weights is None:
        weights = DEFAULT_WEIGHTS

    dims = {}
    dims["price"] = score_price(product.get("price_usd"))
    dims["demand"] = score_demand(
        product.get("bsr", []),
        product.get("review_count", 0),
        product.get("monthly_bought", ""),
    )
    dims["competition"] = score_competition(product.get("review_count"))
    dims["brand"] = score_brand(product.get("brand", ""))
    dims["safety"] = score_safety(product)
    dims["social"] = score_social(
        product.get("rating"),
        product.get("review_count"),
    )

    total = sum(dims[k] * weights.get(k, 0) / 100.0 for k in dims)
    total = round(total, 1)

    return total, dims


def score_all(products, weights=None):
    """批量打分，返回按总分降序排列"""
    results = []
    for p in products:
        total, dims = score_product(p, weights)
        results.append({
            **p,
            "score": total,
            "score_details": dims,
        })
    results.sort(key=lambda x: x["score"], reverse=True)
    return results


def format_score_breakdown(dims, weights=None):
    """生成分数明细文字"""
    if weights is None:
        weights = DEFAULT_WEIGHTS
    lines = []
    labels = {
        "price": "价格", "demand": "需求", "competition": "竞争",
        "brand": "品牌", "safety": "安全", "social": "社交",
    }
    for k in ["price", "demand", "competition", "brand", "safety", "social"]:
        raw = dims.get(k, 0)
        weighted = round(raw * weights.get(k, 0) / 100.0, 1)
        lines.append(f"{labels.get(k,k)}({weights.get(k,0)}%)={weighted}")
    return " | ".join(lines)


def get_recommendation(score):
    """根据总分给出建议"""
    if score >= 80: return "★★★★★ 强烈推荐"
    if score >= 70: return "★★★★ 推荐"
    if score >= 60: return "★★★ 可以尝试"
    if score >= 50: return "★★ 谨慎"
    return "★ 不推荐"


def save_weights(weights, filepath="weights_history.json"):
    """保存权重版本"""
    record = {
        "timestamp": datetime.now().isoformat(),
        "weights": weights,
    }
    history = []
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                history = json.load(f)
        except: pass
    history.append(record)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)
    return len(history)


if __name__ == "__main__":
    # 快速测试
    test = [
        {"asin":"B07KM1","title":"Yonex Racket","brand":"YONEX","price_usd":44.20,"rating":4.4,"review_count":2411,"bsr":[{"rank":"12,734"}],"monthly_bought":"300+","is_sponsored":False},
        {"asin":"B0XXXX2","title":"Cheap Generic","brand":"Generic","price_usd":3.99,"rating":3.2,"review_count":5,"bsr":[{"rank":"500,000"}],"monthly_bought":"","is_sponsored":True},
        {"asin":"B0MID3","title":"Hot New Item","brand":"NewBrand","price_usd":19.99,"rating":4.6,"review_count":85,"bsr":[{"rank":"800"}],"monthly_bought":"2K+","is_sponsored":False},
    ]
    results = score_all(test)
    for r in results:
        print(f"{r['asin']} → {r['score']}分 {get_recommendation(r['score'])}")
        print(f"  {format_score_breakdown(r['score_details'])}")
