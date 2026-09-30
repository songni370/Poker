import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 生产构建产物固定输出到 dist/client，由同一个 Fastify 进程托管。
export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // 开发期 Vite 独立端口，API 与 WebSocket 反向代理到单进程服务端（生产无此代理）。
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
    // 运行期数据目录不通过开发服务器暴露。
    fs: { deny: ['data/**', '.env', '**/*.sqlite*'] },
  },
})
