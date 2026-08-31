"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const webpack_1 = __importDefault(require("webpack"));
const html_webpack_plugin_1 = __importDefault(require("html-webpack-plugin"));
const node_polyfill_webpack_plugin_1 = __importDefault(require("node-polyfill-webpack-plugin"));
// 配置在 web/ 内, 自身即 web 根; .env 在 web/, 显式 ./.env.${DEPLOY_ENV}
const WEB = __dirname;
const PROJECT_ROOT = path_1.default.resolve(WEB, '..');
function loadEnvVar(name, fallback = '') {
    // 优先 web/.env, 兜底项目根 .env (兼容老配置)
    const candidates = [
        path_1.default.resolve(WEB, `.env.${process.env.DEPLOY_ENV || 'development'}`),
        path_1.default.resolve(PROJECT_ROOT, `.env.${process.env.DEPLOY_ENV || 'development'}`),
    ];
    for (const envFile of candidates) {
        try {
            if (!fs_1.default.existsSync(envFile))
                continue;
            const content = fs_1.default.readFileSync(envFile, 'utf-8');
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#'))
                    continue;
                const eq = trimmed.indexOf('=');
                if (eq <= 0)
                    continue;
                const key = trimmed.slice(0, eq).trim();
                if (key === name) {
                    return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
                }
            }
        }
        catch { /* ignore */ }
    }
    return fallback;
}
/** env var 解析: process.env (cli 注入) 优先, 兜底 .env (直接 cd client && npm run dev 用), 最后 hardcoded 默认 */
function getEnv(name, fallback = '') {
    return process.env[name] || loadEnvVar(name, '') || fallback;
}
const isDev = process.env.NODE_ENV !== 'production';
const config = {
    mode: isDev ? 'development' : 'production',
    target: 'web',
    entry: path_1.default.resolve(WEB, 'src/index.tsx'),
    output: {
        path: path_1.default.resolve(WEB, 'dist'),
        filename: '[name].[contenthash:8].js',
        publicPath: '/',
    },
    cache: {
        type: 'filesystem',
        cacheDirectory: path_1.default.resolve(WEB, '.webpack-cache'),
        // monaco-editor 等大依赖单独缓存, 避免每次 dev rebuild 都全量转译
        buildDependencies: {
            config: [__filename],
        },
    },
    watchOptions: {
        // 排除输出/缓存/运行期数据目录, 避免删除/重建目录时 watcher ENOENT 风暴杀掉 webpack
        ignored: [
            // dev trace: 临时把 customEditors.js 从排除中拿掉, 让我们改 node_modules 也能热重载
            '**/node_modules/(?!@opensumi/ide-extension/lib/browser/vscode/contributes/customEditors.js)',
            '**/.webpack-cache/**',
            '**/dist/**',
            '**/.playwright-screenshots/**',
            '**/.playwright-mcp/**',
        ],
        poll: false,
        aggregateTimeout: 200,
    },
    optimization: {
        // 把 monaco-editor 这种超大模块拆到独立 chunk, 避免单个 bundle 过大
        splitChunks: {
            chunks: 'all',
            cacheGroups: {
                monaco: {
                    test: /[\\/]node_modules[\\/]@opensumi[\\/]monaco-editor-core[\\/]/,
                    name: 'monaco-core',
                    chunks: 'all',
                    priority: 30,
                },
                opensumi: {
                    test: /[\\/]node_modules[\\/]@opensumi[\\/]/,
                    name: 'opensumi',
                    chunks: 'all',
                    priority: 20,
                },
                codeblitz: {
                    test: /[\\/]node_modules[\\/]@codeblitzjs[\\/]/,
                    name: 'codeblitz',
                    chunks: 'all',
                    priority: 25,
                },
                vendors: {
                    test: /[\\/]node_modules[\\/]/,
                    name: 'vendors',
                    chunks: 'all',
                    priority: 10,
                },
            },
        },
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.json'],
        alias: {
            '@': path_1.default.resolve(WEB, 'src'),
            '@/': path_1.default.resolve(WEB, 'src') + path_1.default.sep,
            // 根治 vsix customEditor (paper) 刷新后激活 tab 不渲染: 用本地 patch 替换 opensumi 原版
            // web/src/patches/customEditors.js 加 useRef 标记, 避免 React 18 dev mode StrictEffects 双调用
            // 配合 web/src/patches/patch-custom-editor.ts 接管 webview 生命周期
            '@opensumi/ide-extension/lib/browser/vscode/contributes/customEditors.js': path_1.default.resolve(WEB, 'src/patches/customEditors.js'),
            '@opensumi/ide-extension/lib/browser/vscode/contributes/customEditors': path_1.default.resolve(WEB, 'src/patches/customEditors.js'),
            // 注: WORKSPACE_ROOT patch 不走 alias (codeblitz 包内相对路径互引 alias 不生效),
            //     由 postinstall 脚本就地改 node_modules (scripts/patch-codeblitz-constant.js)
        },
        fallback: {
            // 构建期 fallback: 供第三方库（opensumi/codeblitz）浏览器兼容, src 本身零 node 依赖
            path: require.resolve('path-browserify'),
            fs: false,
            crypto: false,
            stream: false,
            buffer: false,
            os: false,
            process: false,
        },
    },
    experiments: {
        asyncWebAssembly: true,
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                // 排除 numas 自己的 node_modules (相对 web/ 项目根), 不用 /node_modules/ 这种
                // 简单 regex, 因为 npx 跑时 file path 包含 /node_modules/numas/, 用简单 regex
                // 会错误排除 numas 自己的源码, 导致 esbuild-loader 不匹配, 走默认 js parser 报错.
                exclude: /\/node_modules\/(?!numas\/)/,
                use: [{
                        loader: 'esbuild-loader',
                        options: {
                            // esbuild-loader 默认 tsx=transform, target=es2015; loader 内置 ts 配置
                            // 不需要 tsconfig (但项目里有 src/ tsconfig.json 给 src/ 自己的 typecheck 用, 不影响构建)
                            loader: 'tsx',
                            target: 'es2020',
                        },
                    }],
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader'],
            },
            {
                test: /\.module\.less$/,
                use: [
                    { loader: 'style-loader', options: { esModule: false } },
                    {
                        loader: 'css-loader',
                        options: {
                            importLoaders: 1,
                            sourceMap: true,
                            esModule: false,
                            modules: { mode: 'local', localIdentName: '[local]___[hash:base64:5]' },
                        },
                    },
                    { loader: 'less-loader', options: { lessOptions: { javascriptEnabled: true } } },
                ],
            },
            {
                test: /^((?!\.module).)*less$/,
                use: [
                    { loader: 'style-loader', options: { esModule: false } },
                    {
                        loader: 'css-loader',
                        options: { importLoaders: 1, sourceMap: true, esModule: false },
                    },
                    {
                        loader: 'less-loader',
                        options: {
                            lessOptions: {
                                javascriptEnabled: true,
                                modifyVars: {
                                    'kt-html-selector': 'alex-root',
                                    'kt-body-selector': 'alex-root',
                                },
                            },
                        },
                    },
                ],
            },
            {
                test: /\.(woff2?|ttf|eot)(\?v=\d+\.\d+\.\d+)?$/,
                use: [
                    {
                        loader: 'file-loader',
                        options: { name: '[name].[ext]', esModule: false, publicPath: './' },
                    },
                ],
            },
            {
                test: /\.(png|jpe?g|gif|webp|ico|svg)(\?.*)?$/,
                use: [
                    {
                        loader: 'url-loader',
                        options: {
                            limit: 10000,
                            name: '[name].[ext]',
                            esModule: false,
                            fallback: { loader: 'file-loader', options: { name: '[name].[ext]', esModule: false } },
                        },
                    },
                ],
            },
            {
                test: /\.(txt|text|md)$/,
                use: 'raw-loader',
            },
        ],
    },
    plugins: [
        new html_webpack_plugin_1.default({
            template: path_1.default.resolve(WEB, 'src/index.html'),
            favicon: path_1.default.resolve(WEB, 'src/assets/favicon.ico'),
        }),
        // 纯前端: 编译期读 env var, DefinePlugin 注入为全局常量（产物无 process/node 引用）
        // 单一事实源: cli's --port 注入 process.env.APP_BASE_URL, 此处优先; .env 兜底
        new webpack_1.default.DefinePlugin({
            __APP_BASE_URL__: JSON.stringify(getEnv('APP_BASE_URL', 'http://127.0.0.1:3100')),
            __APP_REGISTRY_BASE_URL__: JSON.stringify(getEnv('REGISTRY_BASE_URL', 'http://127.0.0.1:7790')),
            __APP_DEPLOY_ENV__: JSON.stringify(process.env.DEPLOY_ENV || 'development'),
        }),
        // 第三方库（opensumi/codeblitz）浏览器 fallback: 构建期 polyfill, src 本身零 node 依赖
        new node_polyfill_webpack_plugin_1.default({ includeAliases: ['process', 'Buffer'] }),
    ],
    // @ts-ignore - devServer 不在 webpack.Configuration 类型里, 但 CLI serve 模式接受
    devServer: {
        allowedHosts: 'all',
        host: '0.0.0.0',
        // 端口由 cli.js 注入 (WEB_PORT env), 兜底 7788
        port: parseInt(process.env.WEB_PORT || '7788', 10),
        historyApiFallback: { disableDotRule: true },
        hot: true,
        client: {
            overlay: { errors: true, warnings: false, runtimeErrors: false },
        },
    },
};

exports.default = config;
