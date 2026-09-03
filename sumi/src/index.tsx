import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
// 根治: 接管 vsix customEditor (paper) webview 生命周期, 避免 React 18 dev mode StrictEffects 双调用导致
//       ref 在 useEffect 异步 .then() 跑回来前被 unmount 设 null 导致的挂载跳过
import { installCustomEditorPatch } from './patches/patch-custom-editor';
import './config/app';
import './styles/overrides.css';
import './styles/slots.css';
// 访问携带 ?directory=<path> 时, 将该路径作为工作目录 (写 APP_CWD; 不同则 reload 一次)
import { applyUrlDirectory } from './service/env';

installCustomEditorPatch();

applyUrlDirectory();

(window as any).React = React;

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// 登录后 agent initRuntime 加载（agent.onStart: 有 APP_CWD 时探 opencode 注入 cwd/shell, 派发 runtime-ready）
ReactDOM.createRoot(container).render(React.createElement(App));