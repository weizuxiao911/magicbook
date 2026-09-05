#!/usr/bin/env node
/**
 * patch-opensumi-storagepath-userhome.js — postinstall: 修补
 * @opensumi/ide-extension-storage/lib/browser/storage-path.js 的
 * ExtensionStoragePathServer.getUserHomeDir() 让它优先读 __APP_CONFIG__.userHome.
 *
 * 治本 framework timing race:
 *   1. codeblitz framework 早期通过 fileServiceClient.getCurrentUserHome() resolve
 *      userHomeDeferred 为 codeblitz DiskFileSystemProvider.getCurrentUserHome() 返回的
 *      Uri.file(HOME_ROOT='/home') (BrowserFS mock, 没有真实 host home).
 *   2. opensumi ExtensionStoragePathServer 没有 _userHome cache (每次 getUserHomeDir()
 *      重新算), 但走 fileSystem.getCurrentUserHome() → 拿 mock.
 *   3. 我们 CustomFsProviderContribution.onStart() 后注册 CustomFileSystemProvider,
 *      userHomeDeferred 二次 resolve 为 cwd='/workspace/通识教育'. 但 framework 已 await
 *      过的 promise 不会重跑.
 *   4. framework 调 mkdir header='/home/numas/numas' (Uri('/home').resolve('.codeblitz')
 *      经 toHostPath + resolveFsPath fallback 拆出来的非 docker 真实路径) → server 500.
 *
 * 根治: patch opensumi lib 的 getUserHomeDir() 让它永远读 window.__APP_CONFIG__.userHome
 * (opencode /path 接口注入的真实 host home). 跳过 fileSystem mock + 跳过 framework 早期
 * cache. docker 容器内真实 host home (例如 /home/numas) → mkdir 200.
 *
 * 幂等: marker 检测已 patch 跳过. lib 版本升级 regex 模式还能命中就继续打.
 */

const fs = require('node:fs');
const path = require('node:path');

const TARGET_FILE = path.resolve(
  __dirname,
  '../node_modules/@opensumi/ide-extension-storage/lib/browser/storage-path.js',
);
const MARKER = '__numasOpensumiStoragePath';

const OLD = `    async getUserHomeDir() {
        const homeDirStat = await this.fileSystem.getCurrentUserHome();
        if (!homeDirStat) {
            throw new Error('Unable to get user home directory');
        }
        const homeDirPath = await this.fileSystem.getFsPath(homeDirStat.uri);
        return homeDirPath;
    }`;

const NEW = `    async getUserHomeDir() {
        // numas patch (__numasOpensumiStoragePath): 优先读 window.__APP_CONFIG__.userHome
        //   (由 opencode /path 接口注入的 host 真实 home). framework 早期
        //   fileSystem.getCurrentUserHome() 会命中 codeblitz 自带 DiskFileSystemProvider
        //   的 mock (返回 HOME_ROOT='/home'), 配合 toHostPath + resolveFsPath fallback 拼出
        //   /home/numas/numas 这种 docker 容器内不存在的路径 → mkdir 500.
        //   直接读已注入的 userHome 绕过 mock + 早期 cache, 保证 docker 容器下 extension
        //   storage 路径真实. opensumi ExtensionStoragePathServer 没有 _userHome cache,
        //   patch 这一个函数即可覆盖所有 framework 内部 homeDir 计算.
        const __numasInjected = (typeof window !== 'undefined' && window.__APP_CONFIG__ && window.__APP_CONFIG__.userHome) || '';
        if (__numasInjected) return __numasInjected;
        const homeDirStat = await this.fileSystem.getCurrentUserHome();
        if (!homeDirStat) {
            throw new Error('Unable to get user home directory');
        }
        const homeDirPath = await this.fileSystem.getFsPath(homeDirStat.uri);
        return homeDirPath;
    }`;

function patch() {
  if (!fs.existsSync(TARGET_FILE)) {
    console.warn('[patch-opensumi-storagepath] target not found:', TARGET_FILE);
    return false;
  }
  let src = fs.readFileSync(TARGET_FILE, 'utf-8');
  if (src.includes(MARKER)) {
    console.log('[patch-opensumi-storagepath] 已 patch, 跳过');
    return true;
  }
  if (!src.includes(OLD)) {
    console.warn('[patch-opensumi-storagepath] OLD 未匹配, 包版本可能变化, 请检查', TARGET_FILE);
    return false;
  }
  fs.writeFileSync(TARGET_FILE, src.replace(OLD, NEW));
  console.log('[patch-opensumi-storagepath] getUserHomeDir → __APP_CONFIG__.userHome patch applied');
  return true;
}

if (!patch()) process.exitCode = 1;