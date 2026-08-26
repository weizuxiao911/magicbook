import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import './config/app';
import './styles/overrides.css';
import './styles/slots.css';

(window as any).React = React;

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// 登录后 agent initRuntime 加载（agent.onStart: 有 APP_CWD 时探 opencode 注入 cwd/shell, 派发 runtime-ready）
ReactDOM.createRoot(container).render(React.createElement(App));