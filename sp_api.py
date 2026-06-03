"""
Amazon SP-API 真实数据接入
拿到凭证后填入 SP_API_CONFIG，运行 python sp_api.py --test
"""
import httpx
import time
import json
import os
import sys
from datetime import datetime, timedelta

# ====== 你拿到凭证后填这里 ======
SP_API_CONFIG = {
    "client_id": "",          # amzn1.application-xxx...
    "client_secret": "",      # 你的 Client Secret
    "refresh_token": "",      # Atzr|xxx...
    "role_arn": "",           # arn:aws:iam::xxx:role/xxx
    "region": "na",           # na/eu/fe
    "marketplace_id": "ATVPDKIKX0DER",  # Amazon.com
}

# ====== API 端点 ======
API_BASE = "https://sellingpartnerapi-na.amazon.com"
TOKEN_URL = "https://api.amazon.com/auth/o2/token"

def get_access_token():
    """获取 LWA 访问令牌"""
    cfg = SP_API_CONFIG
    resp = httpx.post(TOKEN_URL, data={
        "grant_type": "refresh_token",
        "refresh_token": cfg["refresh_token"],
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
    })
    if resp.status_code != 200:
        raise Exception(f"Token error: {resp.status_code} {resp.text}")
    return resp.json()["access_token"]


def sp_api_request(path, params=None, method="GET", data=None):
    """通用 SP-API 请求"""
    token = get_access_token()
    headers = {
        "x-amz-access-token": token,
        "x-amz-date": datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"),
    }
    url = f"{API_BASE}{path}"
    if method == "GET":
        resp = httpx.get(url, headers=headers, params=params, timeout=30)
    else:
        resp = httpx.post(url, headers=headers, json=data, timeout=30)
    if resp.status_code != 200:
        raise Exception(f"API error {resp.status_code}: {resp.text[:300]}")
    return resp.json()


# ====== 核心接口 ======

def get_inventory():
    """获取 FBA 库存 (每个 SKU/ASIN 的当前库存量)"""
    data = sp_api_request("/fba/inventory/v1/summaries",
        params={"granularityType": "Marketplace", "granularityId": SP_API_CONFIG["marketplace_id"]})
    items = []
    for item in data.get("payload", {}).get("inventorySummaries", []):
        items.append({
            "asin": item.get("asin"),
            "sku": item.get("sku"),
            "fnsku": item.get("fnSku"),
            "fba_qty": item.get("totalQuantity", 0),
            "condition": item.get("condition"),
        })
    return items


def get_orders(created_after=None, max_results=50):
    """获取最近订单列表"""
    if not created_after:
        created_after = (datetime.now() - timedelta(days=30)).isoformat()
    data = sp_api_request("/orders/v0/orders", params={
        "MarketplaceIds": SP_API_CONFIG["marketplace_id"],
        "CreatedAfter": created_after,
        "OrderStatuses": "Shipped",
        "MaxResultsPerPage": max_results,
    })
    orders = []
    for o in data.get("payload", {}).get("Orders", []):
        orders.append({
            "amazon_order_id": o.get("AmazonOrderId"),
            "purchase_date": o.get("PurchaseDate"),
            "order_status": o.get("OrderStatus"),
            "total_amount": o.get("OrderTotal", {}).get("Amount"),
            "currency": o.get("OrderTotal", {}).get("CurrencyCode"),
        })
    return orders


def get_order_items(order_id):
    """获取订单包含的商品"""
    data = sp_api_request(f"/orders/v0/orders/{order_id}/orderItems")
    items = []
    for item in data.get("payload", {}).get("OrderItems", []):
        items.append({
            "asin": item.get("ASIN"),
            "sku": item.get("SellerSKU"),
            "title": item.get("Title"),
            "qty": item.get("QuantityOrdered"),
            "item_price": item.get("ItemPrice", {}).get("Amount"),
            "shipping_price": item.get("ShippingPrice", {}).get("Amount"),
        })
    return items


def get_financial_events(posted_after=None, max_results=50):
    """获取财务事件（销售额/FBA费/退款）"""
    if not posted_after:
        posted_after = (datetime.now() - timedelta(days=30)).isoformat()
    data = sp_api_request("/finances/v0/financialEvents", params={
        "PostedAfter": posted_after,
        "MaxResultsPerPage": max_results,
    })
    payload = data.get("payload", {})
    events = []

    # 销售事件
    for e in payload.get("ShipmentEventList", []):
        for item in e.get("ShipmentItemList", []):
            events.append({
                "type": "shipment",
                "asin": item.get("SellerSKU", ""),
                "qty": item.get("QuantityShipped", 0),
                "revenue": float(item.get("ItemChargeList", [{}])[0].get("ChargeAmount", {}).get("CurrencyAmount", 0)),
                "fba_fee": 0,
                "date": e.get("PostedDate"),
            })

    # FBA 费事件
    for e in payload.get("FBALiquidationEventList", []):
        pass  # 简化

    # 退款事件
    for e in payload.get("RefundEventList", []):
        events.append({
            "type": "refund",
            "asin": "",
            "qty": 1,
            "revenue": -float(e.get("RefundAmount", {}).get("TotalAmount", {}).get("CurrencyAmount", 0)),
            "date": e.get("PostedDate"),
        })

    return events


def get_fba_fees(asin, price):
    """获取 FBA 费用估算"""
    data = sp_api_request("/productFees/v0/feesEstimate", method="POST", data={
        "FeesEstimateRequest": {
            "Identifier": asin,
            "MarketplaceId": SP_API_CONFIG["marketplace_id"],
            "PriceToEstimateFees": {
                "ListingPrice": {"CurrencyCode": "USD", "Amount": price},
                "Shipping": {"CurrencyCode": "USD", "Amount": 0},
            },
        }
    })
    fees = {}
    for fee in data.get("payload", {}).get("FeesEstimateResult", {}).get("Fees", []):
        name = fee.get("FeeType", "")
        amount = fee.get("FeeAmount", {}).get("Amount", 0)
        fees[name] = float(amount)
    return fees


# ====== 批量同步 ======
def sync_all_data(output_file=None):
    """同步所有数据到 JSON"""
    print("正在同步 SP-API 数据...")
    start = time.time()

    try:
        inventory = get_inventory()
        print(f"  FBA 库存: {len(inventory)} 个 SKU")
    except Exception as e:
        print(f"  FBA 库存失败: {e}")
        inventory = []

    try:
        orders = get_orders()
        print(f"  最近订单: {len(orders)} 个")
    except Exception as e:
        print(f"  订单失败: {e}")
        orders = []

    try:
        finances = get_financial_events()
        print(f"  财务事件: {len(finances)} 条")
    except Exception as e:
        print(f"  财务失败: {e}")
        finances = []

    result = {
        "updated": datetime.now().isoformat(),
        "inventory": inventory,
        "orders": orders,
        "finances": finances,
    }

    if output_file:
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        print(f"  已保存: {output_file}")

    print(f"  耗时: {time.time()-start:.1f}s")
    return result


# ====== CLI ======
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Amazon SP-API 数据接入")
    parser.add_argument("--test", action="store_true", help="测试 API 连接")
    parser.add_argument("--sync", action="store_true", help="同步全部数据")
    parser.add_argument("--inventory", action="store_true", help="仅查库存")
    parser.add_argument("--orders", action="store_true", help="仅查订单")

    args = parser.parse_args()

    cfg = SP_API_CONFIG
    if not cfg["client_id"] or not cfg["refresh_token"]:
        print("请先填入 SP_API_CONFIG！")
        print("需要:")
        print("  1. AWS IAM 角色 ARN")
        print("  2. SP-API Client ID")
        print("  3. SP-API Client Secret")
        print("  4. SP-API Refresh Token")
        sys.exit(1)

    if args.test:
        print("测试连接...")
        try:
            token = get_access_token()
            print(f"  ✅ Token: {token[:30]}...")
            inv = get_inventory()
            print(f"  ✅ 库存: {len(inv)} 个 SKU")
        except Exception as e:
            print(f"  ❌ 失败: {e}")

    elif args.sync:
        sync_all_data("../shared_data_sp.json")

    elif args.inventory:
        inv = get_inventory()
        for item in inv:
            print(f"  {item['asin']:12s} | FBA: {item['fba_qty']:4d} | SKU: {item['sku']}")

    elif args.orders:
        orders = get_orders()
        for o in orders[:10]:
            print(f"  {o['amazon_order_id']} | {o['purchase_date'][:10]} | {o['total_amount']} {o['currency']}")
