/**
 * workspace 拓展入口 — web/src/extensions/workspace/module.ts
 *
 * 现在 workspace 拓展只提供:
 *  - WorkspacePicker modal (被 chat 通过 workspace:request-show 事件触发)
 *  - WorkspaceView 引导页 (无 APP_CWD 时 Explorer 显示, 提示去 chat 切目录)
 *
 * 工作目录切换入口已下放到 chat 输入框底部, 这里是单一 module, 不再注册 OPEN_FOLDER 命令.
 * 事件链:
 *   [chat 输入框] --workspace:request-show--> [WorkspacePicker]
 *   [WorkspacePicker.confirm] --setCwd()--> [service/workspace] --reload-->
 */

import { Injectable, Autowired } from '@opensumi/di';
import { Domain, CommandContribution, CommandRegistry, BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common/workspace.interface';
import { IFileTreeService } from '@opensumi/ide-file-tree-next/lib/common';
import { URI, FileStat } from '@opensumi/ide-core-common';

import { getWorkspace } from '../../infra/url';
import { normalizeCwdPath } from '../../infra/path';

@Injectable()
@Domain(CommandContribution, ClientAppContribution)
export class WorkspaceContribution implements CommandContribution, ClientAppContribution {
  @Autowired(IWorkspaceService)
  workspaceService: IWorkspaceService;
  @Autowired(IFileTreeService)
  fileTreeService: IFileTreeService;

  registerCommands(commands: CommandRegistry): void {
    // 不再注册 OPEN_FOLDER — 切工作目录入口统一在 chat 输入框底部
  }

  async onStart(): Promise<void> {
    // workspace 来源: URL `?directory=` > __APP_CONFIG__.cwd (opencode /path 注入).
    // setWorkspace 同步 explorer 根 (走 codeblitz IWorkspaceService).
    const ws = normalizeCwdPath(getWorkspace());
    if (!ws) return;
    const driveLower = ws.replace(/^\/+/, '').match(/^([A-Za-z]):/);
    const filePath = driveLower
      ? '/' + driveLower[1].toLowerCase() + ':' + ws.replace(/^[A-Za-z]:/, '')
      : ws;
    const uriStr = `file://${filePath}`;
    const uri = URI.parse(uriStr);
    const stat: FileStat = {
      uri,
      lastModification: 0,
      isDirectory: true,
      name: driveLower ? driveLower[1].toLowerCase() + ':' : undefined,
    } as any;
    try {
      await this.workspaceService.setWorkspace(stat);
      console.log('[workspace] setWorkspace ok:', uriStr);
      // FileTreeService.init 在 onStart 早期已 fire-and-forget 拿到空 roots;
      // setWorkspace 更新 roots 后必须显式刷新 FileTree.
      try {
        await this.fileTreeService?.refresh?.();
      } catch (e) {
        console.warn('[workspace] fileTreeService refresh 失败:', e);
      }
    } catch (e) {
      console.error('[workspace] setWorkspace 失败:', e);
    }
  }
}

@Injectable()
export class WorkspaceModule extends BrowserModule {
  providers = [WorkspaceContribution];
  contributionProvider = [CommandContribution, ClientAppContribution];
}
