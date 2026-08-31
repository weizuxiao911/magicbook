import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
// 根治: 接管 vsix customEditor (paper) webview 生命周期, 避免 React 18 dev mode StrictEffects 双调用导致
//       ref 在 useEffect 异步 .then() 跑回来前被 unmount 设 null 导致的挂载跳过
import { installCustomEditorPatch } from './patches/patch-custom-editor';
import './config/app';
import './styles/overrides.css';
import './styles/slots.css';

installCustomEditorPatch();

(window as any).React = React;

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// 登录后 agent initRuntime 加载（agent.onStart: 有 APP_CWD 时探 opencode 注入 cwd/shell, 派发 runtime-ready）
ReactDOM.createRoot(container).render(React.createElement(App));