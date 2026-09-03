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

  onStart(): void {
    const cwd = localStorage.getItem('APP_CWD');
    if (cwd) {
      // 有 APP_CWD: 已选择过工作目录, 直接进入 (opencode/fs 已由 select 启动)
      // 同时显式 setWorkspace 让 opensumi file-tree explorer 根 = cwd (Windows 关键:
      // App.tsx workspaceDir='/' 在 Windows = 盘符根, explorer 提示"无打开的文件夹";
      // 主动 setWorkspace 覆盖默认 roots → explorer 跟 effectiveCwd 同步).
      // 不走 URI.file (opensumi URI.file Windows 盘符 encode 成 d%3A, 跟 codeblitz
      // 'file:///d:/...' URI 形态不匹配 → workspace roots 错, explorer 空).
      // 直接拼: Windows 'D:/foo' → 'file:///d:/foo' (盘符小写, 跟 codeblitz 一致);
      // POSIX '/Users/foo' → 'file:///Users/foo'.
      const norm = cwd.replace(/\\/g, '/');
      const driveLower = norm.replace(/^\/+/, '').match(/^([A-Za-z]):/);
      const filePath = driveLower
        ? '/' + driveLower[1].toLowerCase() + ':' + norm.replace(/^[A-Za-z]:/, '')
        : norm;
      const uri = URI.parse(`file://${filePath}`);
      const stat: FileStat = {
        uri,
        lastModification: 0,
        isDirectory: true,
      } as any;
      this.workspaceService.setWorkspace(stat);
      console.log('[workspace] setWorkspace:', uri.toString());
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
