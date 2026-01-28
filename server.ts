const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url)
    let pathname = url.pathname

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
