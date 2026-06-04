/**
 * CF Worker HTTP 转发代理 v7 — 正确处理二进制（图片）和文本（HTML）
 */
export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);
    let target = reqUrl.searchParams.get('url');

    if (!target) {
      return new Response('OK. Usage: ?url=https://...', {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // 双重 URL decode
    try { target = decodeURIComponent(target); } catch(e) {}
    try { target = decodeURIComponent(target); } catch(e) {}

    const resp = await fetch(target, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.amazon.com/',
        'Origin': 'https://www.amazon.com',
        'Sec-Ch-Ua': '"Google Chrome";v="125", "Chromium";v="125"',
      },
      redirect: 'follow',
    });

    const contentType = resp.headers.get('content-type') || '';

    // 图片 / 二进制文件 — 返回原始字节
    if (contentType.startsWith('image/') ||
        contentType.startsWith('application/octet') ||
        contentType.includes('binary')) {
      const bytes = await resp.arrayBuffer();
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'X-Proxy-Type': 'binary',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // 文本 — 返回 text
    const body = await resp.text();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Proxy-Type': 'text',
        'X-Amz-Response-Url': resp.url || '',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
};
