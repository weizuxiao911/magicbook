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

import { WorkspaceView } from './WorkspaceView';

@Injectable()
@Domain(CommandContribution, ClientAppContribution)
export class WorkspaceContribution implements CommandContribution, ClientAppContribution {
  @Autowired(IMainLayoutService)
  layoutService: IMainLayoutService;

  registerCommands(commands: CommandRegistry): void {
    // 不再注册 OPEN_FOLDER — 切工作目录入口统一在 chat 输入框底部
  }

  onStart(): void {
    const cwd = localStorage.getItem('APP_CWD');
    if (cwd) {
      // 有 APP_CWD: 已选择过工作目录, 直接进入 (opencode/fs 已由 select 启动)
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
