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
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';
import { EXPLORER_CONTAINER_ID } from '@opensumi/ide-explorer/lib/browser/explorer-contribution';
import { IWorkspaceService } from '@opensumi/ide-workspace/lib/common/workspace.interface';
import { URI, FileStat } from '@opensumi/ide-core-common';

import { WorkspaceView } from './WorkspaceView';

@Injectable()
@Domain(CommandContribution, ClientAppContribution)
export class WorkspaceContribution implements CommandContribution, ClientAppContribution {
  @Autowired(IMainLayoutService)
  layoutService: IMainLayoutService;
  @Autowired(IWorkspaceService)
  workspaceService: IWorkspaceService;

  registerCommands(commands: CommandRegistry): void {
    // 不再注册 OPEN_FOLDER — 切工作目录入口统一在 chat 输入框底部
  }

  async onStart(): Promise<void> {
    const cwd = localStorage.getItem('APP_CWD');
    if (cwd) {
      // 有 APP_CWD: 主动 setWorkspace 同步 explorer 根. URI 用 file:// 拼接 normalized 路径
      // (盘符小写), 避开 opensumi URI.file/parse 在 Windows encode 盘符 (d%3A) 的问题.
      // 关键: setWorkspace 是 async (内部 updateWorkspace → updateRoots), 必须 await —
      // FileTreeService.init 读 workspaceService.roots promise, fire-and-forget 会导致
      // FileTreeService 拿到空 roots → explorer 显示"无打开的文件夹"引导页 (实测).
      const norm = cwd.replace(/\\/g, '/');
      const driveLower = norm.replace(/^\/+/, '').match(/^([A-Za-z]):/);
      const filePath = driveLower
        ? '/' + driveLower[1].toLowerCase() + ':' + norm.replace(/^[A-Za-z]:/, '')
        : norm;
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
      } catch (e) {
        console.error('[workspace] setWorkspace 失败:', e);
      }
      return;
    }
    // 无 APP_CWD: 注册 WORKSPACE view 引导去 chat 切目录
    this.layoutService.collectViewComponent({
      id: 'file-explorer',
      component: WorkspaceView,
      name: '工作空间',
      priority: 10,
    }, EXPLORER_CONTAINER_ID);
  }
}

@Injectable()
export class WorkspaceModule extends BrowserModule {
  providers = [WorkspaceContribution];
  contributionProvider = [CommandContribution, ClientAppContribution];
}
