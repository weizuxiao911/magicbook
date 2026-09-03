/**
 * 自定义 file scheme 文档 provider — service/filesystem/doc-provider.ts
 *
 * 背景 (editor 保存不到服务器的根因):
 *   codeblitz/opensumi 的 @opensumi/ide-file-scheme 注册了 FileSchemeDocumentProvider,
 *   它 handlesUri('file') 返回权重 20, 高于默认 fs-editor-doc 的 10, 因此 **editor
 *   打开/保存 file:// 文档时走它**. 而它的 saveDocumentModel 把内容经
 *   fileSchemeDocClient (RPC) 发到 worker/node 端的 FileSchemeDocNodeService,
 *   worker 用自己的 fs (BrowserFS / IndexedDB) 写盘 —— 完全绕开浏览器主线程的
 *   IFileServiceClient (我们替换成 HTTP 的 CustomFileSystemProvider).
 *   结果: explorer 的新建/改名/删除 (走主线程 FSC) 正常, read/watcher 正常,
 *   但 editor 编辑保存的内容落到 worker fs, 服务器收不到.
 *
 * 修法:
 *   注册一个 handlesUri('file') 权重 **30** (>20) 的文档 provider, 直接继承
 *   BaseFileSystemEditorDocumentProvider —— 它的 provideEditorDocumentModelContent /
 *   saveDocumentModel 全部走主线程 IFileServiceClient.readFile / setContent / createFile,
 *   也就是我们的 CustomFileSystemProvider → opencode /api/fs/* HTTP. 不碰 worker RPC.
 *
 * 只覆写 handlesUri / handlesScheme 提权; 其余行为 (read/save/md5/readonly/eol)
 * 全部沿用基类 (基类 fileServiceClient 是我们 patch 过的 FSC 单例).
 */

import { Injectable, Autowired } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { Schemes, URI, Domain } from '@opensumi/ide-core-common';
import { BaseFileSystemEditorDocumentProvider } from '@opensumi/ide-editor/lib/browser/fs-resource/fs-editor-doc';
import { BrowserEditorContribution } from '@opensumi/ide-editor/lib/browser/types';
import type { IEditorDocumentModelContentRegistry } from '@opensumi/ide-editor/lib/browser/doc-model/types';

@Injectable()
export class NumasFileDocProvider extends BaseFileSystemEditorDocumentProvider {
  /** 权重 30: 压过 codeblitz FileSchemeDocumentProvider 的 20, 抢到 file scheme 文档. */
  handlesUri(uri: URI): number {
    return uri.scheme === Schemes.file ? 30 : -1;
  }

  /** 基类 handlesScheme 走 FSC.handlesScheme (file → true, 权重 10);
   *  我们走 handlesUri 提权, 这里返回 false 占位 (与 codeblitz file-doc 一致). */
  handlesScheme(): boolean {
    return false;
  }
}

/**
 * 把 NumasFileDocProvider 注册进 editor 文档 content registry.
 * 注册顺序在 codeblitz FileSystemEditorComponentContribution 之后 (我们的 module 排最后),
 * calculateProvider 按权重取胜, 权重 30 > 20, file scheme 文档落到我们 provider.
 */
@Domain(BrowserEditorContribution)
export class NumasFileDocContribution implements BrowserEditorContribution {
  @Autowired(NumasFileDocProvider)
  private readonly numasFileDocProvider: NumasFileDocProvider;

  registerEditorDocumentModelContentProvider(registry: IEditorDocumentModelContentRegistry): void {
    registry.registerEditorDocumentModelContentProvider(this.numasFileDocProvider);
    console.log('[fs-doc] numas file scheme doc provider registered (weight 30)');
  }
}

@Injectable()
export class FileDocModule extends BrowserModule {
  providers = [NumasFileDocProvider, NumasFileDocContribution];
  contributionProvider = BrowserEditorContribution;
}
