#!/usr/bin/env node
/**
 * patch-codeblitz-homefileserviceprovider.js — postinstall: 修补 codeblitz bundle 的
 * HomeFileServiceProvider.init() 让它优先读 window.__APP_CONFIG__.userHome.
 *
 * 治本 framework timing race 的第二个入口 (第一个是 opensumi
 * ExtensionStoragePathServer.getUserHomeDir, 见 patch-opensumi-storagepath-userhome.js).
 *
 * HomeFileServiceProvider.init() 直接 await fileServiceClient.getCurrentUserHome(), 拿到
 * framework 早期 cache 的 BrowserFS mock home (HOME_ROOT='/home'), 拼出 /home/.codeblitz
 * URI 让 IDE 启动时建目录. 我们 CustomFsProviderContribution.onStart() 替换 provider 太晚,
 * userHomeDeferred 已 resolve, 框架拿不到我们覆盖的值.
 *
 * Patch 让 init() 优先读 __APP_CONFIG__.userHome (opencode /path 注入的真实 host home),
 * fallback 才走 fileServiceClient mock. docker 容器内 host home (例如 /home/numas) →
 * 建 /home/numas/.codeblitz → 容器内存在 → mkdir 200.
 *
 * 幂等: 检测 marker (__numasHomeFileServiceProviderInit) 跳过.
 */

const fs = require('node:fs');
const path = require('node:path');

const TARGET_FILE = path.resolve(
  __dirname,
  '../node_modules/@codeblitzjs/ide-core/bundle/codeblitz.global.js',
);
const MARKER = '__numasHomeFileServiceProviderInit';

const OLD = `    async init() {
        // 请求用户路径并存储
        const home = await this.fileServiceClient.getCurrentUserHome();
        if (home) {
            const userStorageFolderUri = new ide_core_browser_1.URI(home.uri).resolve(this.appConfig.userPreferenceDirName || this.appConfig.preferenceDirName || exports.DEFAULT_USER_STORAGE_FOLDER);
            if (!(await this.fileServiceClient.access(userStorageFolderUri.toString()))) {
                await this.fileServiceClient.createFolder(userStorageFolderUri.toString());
            }
            this.userStorageFolder = userStorageFolderUri;
        }
        this.toDispose.push(this.onDidChangeFileEmitter);
    }`;

const NEW = `    async init() {
        // numas patch (__numasHomeFileServiceProviderInit): 优先读 window.__APP_CONFIG__.userHome
        //   (由 opencode /path 接口注入的 host 真实 home). framework 早期
        //   fileServiceClient.getCurrentUserHome() 拿的是 codeblitz DiskFileSystemProvider mock
        //   (HOME_ROOT='/home'), 配合 toHostPath 拼出 /home/numas/numas 这种 docker 容器内
        //   不存在的路径 → mkdir 500. 直接读已注入的 userHome 绕过早期 cache + mock.
        const __numasInjected = (typeof window !== 'undefined' && window.__APP_CONFIG__ && window.__APP_CONFIG__.userHome) || '';
        let home;
        if (__numasInjected) {
            home = { uri: new ide_core_browser_1.URI(__numasInjected).toString() };
        } else {
            home = await this.fileServiceClient.getCurrentUserHome();
        }
        if (home) {
            const userStorageFolderUri = new ide_core_browser_1.URI(home.uri).resolve(this.appConfig.userPreferenceDirName || this.appConfig.preferenceDirName || exports.DEFAULT_USER_STORAGE_FOLDER);
            if (!(await this.fileServiceClient.access(userStorageFolderUri.toString()))) {
                await this.fileServiceClient.createFolder(userStorageFolderUri.toString());
            }
            this.userStorageFolder = userStorageFolderUri;
        }
        this.toDispose.push(this.onDidChangeFileEmitter);
    }`;

function patch() {
  if (!fs.existsSync(TARGET_FILE)) {
    console.warn('[patch-homefileserviceprovider] target not found:', TARGET_FILE);
    return false;
  }
  let src = fs.readFileSync(TARGET_FILE, 'utf-8');
  if (src.includes(MARKER)) {
    console.log('[patch-homefileserviceprovider] 已 patch, 跳过');
    return true;
  }
  if (!src.includes(OLD)) {
    console.warn('[patch-homefileserviceprovider] OLD 未匹配, bundle 版本可能变化, 请检查', TARGET_FILE);
    return false;
  }
  fs.writeFileSync(TARGET_FILE, src.replace(OLD, NEW));
  console.log('[patch-homefileserviceprovider] HomeFileServiceProvider.init → __APP_CONFIG__.userHome patch applied');
  return true;
}

if (!patch()) process.exitCode = 1;