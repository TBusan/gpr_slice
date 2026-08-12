import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const datasetRoot = path.resolve(__dirname, '..', 'dataset');

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.gvt': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

// 开发服务器：把 ../dataset（管线输出，~600MB）映射到 /dataset/*。
// 注意 server.fs.allow 只管 import 时的 fs 权限，不改变 URL 映射；
// 这里用 connect 中间件直接在根级服务该目录，避免复制/符号链接。
export default defineConfig({
  server: {
    port: 5177,
    fs: {
      allow: ['..'],
    },
  },
  plugins: [
    {
      name: 'gpr-serve-dataset',
      configureServer(server) {
        server.middlewares.use('/dataset', (req, res, next) => {
          const url = decodeURIComponent((req.url || '').split('?')[0]);
          const file = path.join(datasetRoot, url);
          if (file !== datasetRoot && !file.startsWith(datasetRoot + path.sep)) {
            res.statusCode = 403;
            res.end('forbidden');
            return;
          }
          let st;
          try {
            st = fs.statSync(file);
          } catch {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          if (!st.isFile()) {
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          fs.createReadStream(file).pipe(res);
        });
      },
    },
  ],
});
