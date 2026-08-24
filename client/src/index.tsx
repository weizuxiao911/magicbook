import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App';
import './core/config/app';
import './core/styles/overrides.css';
import './core/styles/slots.css';

(window as any).React = React;

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

// 登录后 sandbox 才加载（LoginView.doLogin: get sandbox → applyRuntime → fsUrl 就绪）
ReactDOM.createRoot(container).render(React.createElement(App));