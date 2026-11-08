import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
    resolve: {
      alias: {
        '@dgut-deadline/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 两个 preload：主窗口 index.js + 右下角弹窗 toast.js
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          toast: resolve(__dirname, 'src/preload/toast.ts'),
        },
        output: {
          // preload 必须是 CommonJS，且文件名与主进程中 join(__dirname,'../preload/xxx.js') 一致。
          // 默认在 type:module 下会输出 .mjs，sandbox preload 不支持 ESM，故强制 cjs + .js。
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@dgut-deadline/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        // 两个页面：主界面 index.html + 右下角弹窗 toast.html
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          toast: resolve(__dirname, 'src/renderer/toast.html'),
        },
      },
    },
  },
});
