/**
 * Login 拓展 — extensions/login/
 *
 * OpenSumi 内置拓展: webapp 全屏登录页.
 *   - module.ts    LoginModule + LoginContribution (注册 LoginView 到 login 槽位)
 *   - LoginView.tsx 全屏登录页 (品牌渐变背景 + 磨砂玻璃卡片 + 用户名/密码表单)
 *
 * 登录后初始化 BASE_URL + SDK client, 派发 app.logined / 监听 app.connected.
 * 登出: logout() 清 cookie 刷新回登录页; isLoggedIn/getUsername 读登录态.
 */
export {
  LoginModule,
  LoginContribution,
  LOGIN_SLOT,
  LOGIN_EVENTS,
  USER_COOKIE,
  getCookie,
  isLoggedIn,
  getUsername,
  logout,
} from './module';
