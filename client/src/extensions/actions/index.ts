/**
 * Actions 拓展 — extensions/actions/
 *
 * OpenSumi 拓展 (一个子目录一个拓展):
 *   - module.ts        OpenSumi 扩展注册 (ActionsModule + ActionsContribution)
 *   - ActionsView.tsx  action 槽位 UI: 3 布局 toggle
 *
 * 挂载: ComponentContribution 注册到 SlotLocation.top, 组件 id = 'actions'
 */
export { ActionsModule, ActionsContribution } from './module';
