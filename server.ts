// 代理目标配置
const PROXY_CONFIG = {
  '/proxy/tuwien': 'https://users.cg.tuwien.ac.at',
}

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url)
    let pathname = url.pathname

    // 检查是否为代理请求
    for (const [prefix, target] of Object.entries(PROXY_CONFIG)) {
      if (pathname.startsWith(prefix)) {
        const targetPath = pathname.slice(prefix.length)
        const targetUrl = target + targetPath

        try {
          const proxyReq = await fetch(targetUrl, {
            method: req.method,
            headers: {
              'User-Agent': 'Potree-Next-Proxy/1.0',
            },
          })

          return new Response(proxyReq.body, {
            status: proxyReq.status,
            headers: {
              'Content-Type': proxyReq.headers.get('Content-Type') || 'application/octet-stream',
              'Access-Control-Allow-Origin': '*',
            },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error'
          console.error(`server.ts.fetch: Proxy error for ${targetUrl}: ${message}`)
          return new Response(`Proxy Error: ${message}`, { status: 502 })
        }
      }
    }

    // 默认页面
    if (pathname === '/') {
      pathname = '/vienna_city_center.html'
    }

    // 移除开头的斜杠
    const filePath = '.' + pathname

    const file = Bun.file(filePath)
    const exists = await file.exists()

    if (!exists) {
      return new Response('Not Found', { status: 404 })
    }

    // 设置正确的 MIME 类型
    const ext = pathname.split('.').pop()?.toLowerCase()
    const mimeTypes: Record<string, string> = {
      'html': 'text/html',
      'js': 'application/javascript',
      'mjs': 'application/javascript',
      'css': 'text/css',
      'json': 'application/json',
      'wasm': 'application/wasm',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'wgsl': 'text/plain',
      'ply': 'application/octet-stream',
      'laz': 'application/octet-stream',
      'bin': 'application/octet-stream',
    }

    const contentType = mimeTypes[ext || ''] || 'application/octet-stream'

    return new Response(file, {
      headers: {
        'Content-Type': contentType,
      },
    })
  },
})

console.log(`server.ts: Server running at http://localhost:${server.port}`)
