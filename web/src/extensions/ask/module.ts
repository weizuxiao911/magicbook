/**
 * Ask 拓展入口 — web/src/extensions/ask/module.ts
 *
 * 通用 AI 通道 (跟 filepicker 同级). 任何拓展可直接 `import { requestAI } from './AskService'` 调用.
 * 单例 AskService: 单 EventSource 订阅 /global/event, 多 active request 按 sessionId 派发.
 *
 * 适用场景:
 *   - PDF 标注的"生成"按钮 (独立 session, 不污染 chat 历史)
 *   - 其他程序侧需要跟 AI 交互的功能 (e.g. 自动重命名 / 批量翻译)
 */

import { Injectable } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

@Injectable()
export class AskModule extends BrowserModule {
  providers = [];
}
