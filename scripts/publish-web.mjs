// 把打包好的單檔網頁複製到專案根目錄，作為可直接發佈的網頁版入口。
import { copyFileSync } from 'node:fs';

copyFileSync('dist/app.html', 'index.html');
copyFileSync('public/favicon.png', 'favicon.png');
console.log('已更新根目錄 index.html 與 favicon.png');
