"""
Cloudflare 可用 IP 自动扫描 + 验证系统
集成 9 个开源 IP 源，定时扫描 → 验证 → 累加输出 proxyIP.txt
"""
import re
import time
import json
import os
import ssl
from datetime import datetime

# 优先用 requests，兼容性更好；fallback httpx
try:
    import requests as _http
    _HTTP_BACKEND = 'requests'
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError:
    import httpx
    _HTTP_BACKEND = 'httpx'
    import urllib3
    urllib3.disable_warnings()

OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxyIP.txt")
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxyIP_cache.json")

# CF IP 范围 (这些不是代理, 直接过滤掉)
CF_IP_RANGES = [
    ("103.21.244.", "103.22.200."), ("103.31.4.", "103.31.4."), ("104.16.", "104.31."),
    ("108.162.192.", "108.162.207."), ("131.0.72.", "131.0.75."), ("141.101.64.", "141.101.127."),
    ("162.158.", "162.159."), ("172.64.", "172.71."), ("173.245.48.", "173.245.63."),
    ("188.114.96.", "188.114.111."), ("190.93.240.", "190.93.255."), ("197.234.240.", "197.234.255."),
    ("198.41.128.", "198.41."), ("199.27.128.", "199.27."),
]

def _is_cf_ip(ip):
    """判断是否 Cloudflare CDN IP (不能做代理)"""
    for lo, hi in CF_IP_RANGES:
        if lo <= ip <= hi:
            return True
    return False

# ========== IP 来源 (开源项目 + 公开代理列表) ==========
IP_SOURCES = [
    {
        "name": "free-proxy-list",
        "url": "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
        "parser": "raw_ip_port",
    },
    {
        "name": "proxy-scraper-checker",
        "url": "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
        "parser": "raw_ip_port",
    },
    {
        "name": "fresh-proxy-list",
        "url": "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
        "parser": "raw_ip_port",
    },
    {
        "name": "cf-ip-scanner (vfarid)",
        "url": "https://raw.githubusercontent.com/vfarid/cf-ip-scanner-py/main/ipv4.txt",
        "parser": "cf_format",
    },
    {
        "name": "cloudflare (ip-scanner)",
        "url": "https://raw.githubusercontent.com/ip-scanner/cloudflare/main/ipv4.txt",
        "parser": "cf_format",
    },
    # Additional CF edge IP lists
    {
        "name": "CF preferred IPs (am-cf-tunnel)",
        "url": "https://raw.githubusercontent.com/amclubs/am-cf-tunnel/main/example/ipv4.txt",
        "parser": "cf_format",
    },
    {
        "name": "am-cf-tunnel proxyIP",
        "url": "https://raw.githubusercontent.com/amclubs/am-cf-tunnel/main/example/proxyip.txt",
        "parser": "cf_format",
    },
    {
        "name": "am-cf-tunnel proxyIP AM",
        "url": "https://raw.githubusercontent.com/amclubs/am-cf-tunnel/main/example/proxyip_am.txt",
        "parser": "cf_format",
    },
    {
        "name": "am-cf-tunnel ipv4 CSV",
        "url": "https://raw.githubusercontent.com/amclubs/am-cf-tunnel/main/example/ipv4.csv",
        "parser": "cf_format",
    },
    # 真正的开放HTTP代理列表
    {
        "name": "open-proxy-list (TheSpeedX)",
        "url": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
        "parser": "raw_ip_port",
    },
    {
        "name": "open-proxy-list (jetkai)",
        "url": "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
        "parser": "raw_ip_port",
    },
    {
        "name": "open-proxy-list (roosterkid)",
        "url": "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
        "parser": "raw_ip_port",
    },
    {
        "name": "open-proxy-list (mertguvencli)",
        "url": "https://raw.githubusercontent.com/mertguvencli/http-proxy-list/main/proxy-list/data.txt",
        "parser": "raw_ip_port",
    },
    {
        "name": "open-proxy-list (saschazesiger)",
        "url": "https://raw.githubusercontent.com/saschazesiger/Free-Proxies/master/proxies/http.txt",
        "parser": "raw_ip_port",
    },
    {
        "name": "open-proxy-list (ShiftyTR)",
        "url": "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
        "parser": "raw_ip_port",
    },
]

# ========== 验证目标 ==========
TEST_URLS = [
    "https://www.amazon.com/",
    "https://httpbin.org/ip",
    "https://1.1.1.1/cdn-cgi/trace",
]

def fetch_url(url, timeout=15):
    """抓取 URL 内容"""
    try:
        if _HTTP_BACKEND == 'requests':
            resp = _http.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=timeout, verify=False)
            if resp.status_code == 200 and len(resp.text) > 50:
                return resp.text
        else:
            with httpx.Client(verify=False, timeout=timeout, follow_redirects=True) as client:
                resp = client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                if resp.status_code == 200 and len(resp.text) > 50:
                    return resp.text
    except:
        pass
    return None


def parse_ip_port(text):
    """解析 IP:PORT 格式"""
    ips = []
    # 匹配 IP:PORT 或 IP:PORT#comment
    matches = re.findall(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})', text)
    for ip, port in matches:
        p = int(port)
        if p in (80, 443, 8080, 8443, 2053, 2083, 2087, 2096, 3128):
            ips.append(f"{ip}:{port}")
    return ips


def parse_cf_format(text):
    """解析 CF IP 列表格式: IP:PORT#country"""
    ips = []
    for line in text.split('\n'):
        line = line.strip()
        if not line or line.startswith('#') or line.startswith('['):
            continue
        # 匹配 IP:PORT 或 IP:PORT#tag
        m = re.match(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):?(\d{0,5})', line)
        if m:
            ip = m.group(1)
            port = m.group(2) or '443'
            if port.isdigit():
                country = ''
                tag = re.search(r'#(\w+)', line)
                if tag: country = tag.group(1)
                ips.append({"ip": ip, "port": int(port), "country": country})
    return ips


def scan_all_sources():
    """从所有源收集 IP"""
    all_ips = set()
    cf_ips = []

    print(f"[{datetime.now().strftime('%H:%M:%S')}] 开始扫描 {len(IP_SOURCES)} 个 IP 源...")

    for src in IP_SOURCES:
        try:
            print(f"  [{src['name']}] 抓取中...", end=" ")
            text = fetch_url(src["url"])
            if not text:
                print("失败")
                continue

            if src["parser"] == "raw_ip_port":
                ips = parse_ip_port(text)
                for ip in ips:
                    all_ips.add(ip)
                print(f"OK ({len(ips)} IPs)")

            elif src["parser"] == "cf_format":
                ips = parse_cf_format(text)
                for entry in ips:
                    key = f"{entry['ip']}:{entry['port']}"
                    if key not in all_ips:
                        all_ips.add(key)
                        cf_ips.append(entry)
                print(f"OK ({len(ips)} IPs)")

        except Exception as e:
            print(f"错误: {e}")

    return list(all_ips), cf_ips


def validate_ip(ip, port=443, timeout=8):
    """验证单个 IP 是否可用（TCP 连通 + HTTP 响应）"""
    import socket
    try:
        # TCP 连接测试
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((ip, port))
        sock.close()
        if result != 0:
            return None

        # HTTP 连接测试 (通过 httpbin 验证出口)
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        sock = socket.create_connection((ip, port), timeout=timeout)
        ssock = ctx.wrap_socket(sock, server_hostname="httpbin.org")

        request = (
            f"GET /ip HTTP/1.1\r\n"
            f"Host: httpbin.org\r\n"
            f"User-Agent: Mozilla/5.0\r\n"
            f"Connection: close\r\n\r\n"
        ).encode()
        ssock.sendall(request)

        data = b""
        ssock.settimeout(5)
        try:
            while True:
                chunk = ssock.recv(4096)
                if not chunk: break
                data += chunk
        except: pass
        ssock.close()

        if b"200" in data[:100] and len(data) > 200:
            response_text = data.decode(errors='replace')
            # 检查是否真的是 httpbin 的响应
            if "origin" in response_text:
                delay_ms = int((time.time() - start_time) * 1000) if 'start_time' in dir() else 200
                return {"ip": ip, "port": port, "delay_ms": delay_ms, "exit_ip": response_text[:200]}

        return None
    except:
        return None


def validate_batch(ips, max_test=30):
    """HTTP代理验证 — 测试IP能否真正转发HTTP请求到httpbin.org"""
    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] HTTP代理验证 (Batch {len(ips[:max_test])})...")
    valid = []
    test_ips = ips[:max_test]
    import socket, ssl as _ssl

    for i, ip_str in enumerate(test_ips):
        if isinstance(ip_str, dict):
            ip = ip_str.get("ip", "")
            port = int(ip_str.get("port", 443))
        elif ":" in ip_str:
            parts = ip_str.split(":")
            ip = parts[0]
            port = int(parts[1]) if len(parts) > 1 else 443
        else:
            ip = ip_str
            port = 443

        # Skip private/bogus/CF IPs
        if ip.startswith(("0.", "10.", "127.", "172.16", "192.168", "169.254")):
            continue
        if _is_cf_ip(ip):
            continue  # CF CDN IP, not a real proxy

        try:
            start_t = time.time()
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(4)
            if sock.connect_ex((ip, port)) != 0:
                sock.close()
                continue

            # HTTP代理验证: 发送 CONNECT 或 GET 请求到 httpbin
            ctx = _ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = _ssl.CERT_NONE
            try:
                ssock = ctx.wrap_socket(sock, server_hostname="httpbin.org")
            except:
                sock.close()
                continue

            request = (
                "GET /ip HTTP/1.1\r\n"
                "Host: httpbin.org\r\n"
                "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n"
                "Connection: close\r\n\r\n"
            ).encode()
            ssock.sendall(request)

            data = b""
            ssock.settimeout(5)
            try:
                while True:
                    chunk = ssock.recv(4096)
                    if not chunk: break
                    data += chunk
            except: pass
            ssock.close()

            resp = data.decode(errors='replace')
            if "origin" in resp and "200" in resp[:50]:
                latency = int((time.time() - start_t) * 1000)
                print(f"    ✅ {ip}:{port} ({latency}ms)")
                valid.append({"ip": ip, "port": port, "source": "verified", "latency": latency})
            else:
                # Plain HTTP test (for non-SSL proxies)
                sock2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock2.settimeout(4)
                if sock2.connect_ex((ip, port)) == 0:
                    req2 = (
                        "GET http://httpbin.org/ip HTTP/1.1\r\n"
                        "Host: httpbin.org\r\n"
                        "User-Agent: Mozilla/5.0\r\n"
                        "Connection: close\r\n\r\n"
                    ).encode()
                    sock2.sendall(req2)
                    d2 = b""
                    try:
                        while True:
                            c = sock2.recv(4096)
                            if not c: break
                            d2 += c
                    except: pass
                    r2 = d2.decode(errors='replace')
                    if "origin" in r2:
                        latency = int((time.time() - start_t) * 1000)
                        print(f"    ✅ {ip}:{port} HTTP ({latency}ms)")
                        valid.append({"ip": ip, "port": port, "source": "verified-http", "latency": latency})
                sock2.close()

        except Exception as e:
            pass

        if (i + 1) % 10 == 0:
            print(f"    已验证 {i+1}/{len(test_ips)}, 可用代理 {len(valid)}")

    valid.sort(key=lambda x: x.get("latency", 999))
    return valid


def save_results(valid_ips, accumulate=True):
    """保存到 proxyIP.txt + 缓存。accumulate=True 时累加不覆盖"""
    existing = {}
    if accumulate and os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                old = json.load(f)
            for ip in old.get("ips", []):
                key = f"{ip['ip']}:{ip['port']}"
                existing[key] = ip
            print(f"  [累加] 已有 {len(existing)} 个 IP, 将合并新 IP")
        except: pass

    added = 0
    for entry in valid_ips:
        key = f"{entry['ip']}:{entry['port']}"
        if key not in existing:
            existing[key] = entry
            added += 1

    merged = list(existing.values())
    merged.sort(key=lambda x: x.get("latency", 999))
    print(f"  [累加] +{added} 新 IP, 总计 {len(merged)}")

    # 写 proxyIP.txt
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(f"# proxyIP.txt - Auto-accumulated {datetime.now().isoformat()}\n")
        f.write(f"# Total valid IPs: {len(merged)}\n")
        f.write(f"# Format: IP:PORT#source\n\n")
        for entry in merged:
            f.write(f"{entry['ip']}:{entry['port']}#{entry.get('source', 'scan')}\n")

    # 写缓存 JSON
    cache = {
        "updated": datetime.now().isoformat(),
        "total": len(merged),
        "ips": merged[:1000],  # 最多存 1000 个
    }
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)

    return OUTPUT_FILE, added, len(merged)


def load_cache():
    """读取缓存的 IP 列表"""
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            pass
    return {"ips": [], "updated": "never", "total": 0}


def run_full_scan(max_validate=50, accumulate=True):
    """完整扫描流程"""
    print("=" * 60)
    print("  Cloudflare IP 池自动扫描系统")
    print("=" * 60)

    # 1. 收集
    all_ips, cf_ips = scan_all_sources()
    print(f"\n  总计收集: {len(all_ips)} 个唯一 IP")

    # 2. 验证
    valid = validate_batch(all_ips, max_validate)
    print(f"  验证通过: {len(valid)} 个可用 IP")

    # 3. 保存(累加模式)
    saved_path, added, total = save_results(valid, accumulate=accumulate)
    print(f"\n  已保存到: {saved_path}")
    print(f"  累加: +{added} 新 | 总计: {total}")
    print(f"  缓存文件: {CACHE_FILE}")

    # 4. 输出 Top 10
    if valid:
        print(f"\n  Top 10 可用 IP:")
        for i, ip in enumerate(valid[:10]):
            print(f"    {i+1}. {ip['ip']}:{ip['port']}")

    return valid


def run_loop(interval_minutes=60, max_validate=50):
    """7×24 持续扫描 (每 interval_minutes 分钟跑一次)"""
    print("=" * 60)
    print("  IP 池 7×24 持续扫描模式")
    print(f"  间隔: {interval_minutes} 分钟")
    print(f"  每轮验证: {max_validate} 个 IP")
    print("  Ctrl+C 停止")
    print("=" * 60)

    import signal
    stopped = False
    def handler(sig, frame):
        nonlocal stopped
        print("\n  收到停止信号, 完成当前轮次后退出...")
        stopped = True
    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)

    round_num = 0
    total_added = 0
    while not stopped:
        round_num += 1
        print(f"\n{'─'*50}")
        print(f"  第 {round_num} 轮 — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'─'*50}")

        _, added, total = run_full_scan(max_validate, accumulate=True)
        total_added += added
        cache = load_cache()
        print(f"  累计新增: {total_added} | 池总量: {cache.get('total', '?')}")
        if stopped: break
        print(f"  等待 {interval_minutes} 分钟...")
        time.sleep(interval_minutes * 60)

    cache = load_cache()
    print(f"\n  扫描结束. 共 {round_num} 轮, 新增 {total_added} IP")
    print(f"  最终 IP 池: {cache.get('total', '?')} 个")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="CF IP 池扫描器")
    parser.add_argument("--max", type=int, default=50, help="最大验证 IP 数")
    parser.add_argument("--full", action="store_true", help="完整扫描+验证+累加")
    parser.add_argument("--show", action="store_true", help="显示缓存的 IP")
    parser.add_argument("--loop", action="store_true", help="7×24 持续扫描模式")
    parser.add_argument("--interval", type=int, default=60, help="loop 模式间隔(分钟)")
    parser.add_argument("--serve", action="store_true", help="启动简单 Web API")

    args = parser.parse_args()

    if args.show:
        cache = load_cache()
        print(f"缓存 IP: {cache['total']} 个 (更新于 {cache['updated']})")
        for i, ip in enumerate(cache["ips"][:20]):
            print(f"  {i+1}. {ip['ip']}:{ip['port']}")

    elif args.serve:
        from http.server import HTTPServer, BaseHTTPRequestHandler
        class IPHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                cache = load_cache()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(cache, ensure_ascii=False).encode())
            def log_message(self, *a): pass
        port = 8787
        print(f"IP API Server: http://localhost:{port}")
        HTTPServer(("0.0.0.0", port), IPHandler).serve_forever()

    elif args.loop:
        run_loop(interval_minutes=args.interval, max_validate=args.max)

    elif args.full:
        run_full_scan(args.max, accumulate=True)
    else:
        # Quick scan (collect only, no validation)
        all_ips, _ = scan_all_sources()
        print(f"\n  快速收集完成: {len(all_ips)} 个 IP")
        print(f"  运行 --full 进行完整验证和保存")
