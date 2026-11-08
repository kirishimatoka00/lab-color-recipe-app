import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 網頁版：開發入口為 app.html，打包成單一自足的 HTML（程式、樣式、字型全部內嵌），
// 再由 scripts/publish-web.mjs 複製為根目錄 index.html，
// 因此 GitHub Pages（從 main 根目錄發佈）或直接雙擊檔案都能開啟。
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 5000,
    // favicon 必須內嵌成 data URI。否則 Vite 會把它改名成帶雜湊的檔案，
    // 而單檔版的 index.html 旁邊沒有那個檔案，圖示就會失效。
    assetsInlineLimit: 1024 * 1024,
    rollupOptions: { input: 'app.html' },
  },
});
