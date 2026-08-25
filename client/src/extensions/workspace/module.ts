import { Injectable, Autowired } from '@opensumi/di';
import { Domain, CommandContribution, CommandRegistry } from '@opensumi/ide-core-common';
import { FILE_COMMANDS, BrowserModule, ClientAppContribution } from '@opensumi/ide-core-browser';
import { IMainLayoutService } from '@opensumi/ide-main-layout/lib/common';
import { EXPLORER_CONTAINER_ID } from '@opensumi/ide-explorer/lib/browser/explorer-contribution';

import { WorkspaceView } from './WorkspaceView';

@Injectable()
@Domain(CommandContribution, ClientAppContribution)
export class WorkspaceContribution implements CommandContribution, ClientAppContribution {
  @Autowired(IMainLayoutService)
  layoutService: IMainLayoutService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(FILE_COMMANDS.OPEN_FOLDER, {
      execute: () => window.dispatchEvent(new CustomEvent('workspace:show-picker')),
    });
  }

  onStart(): void {
    const cwd = localStorage.getItem('APP_CWD');
    if (cwd) {
      // 有 APP_CWD: 已选择过工作目录, 直接进入 (opencode/fs 已由 select 启动)
      return;
    }
    // 无 APP_CWD: 注册 WORKSPACE view 引导选择
    this.layoutService.collectViewComponent({
      id: 'file-explorer',
      component: WorkspaceView,
      name: 'WORKSPACE',
      priority: 10,
    }, EXPLORER_CONTAINER_ID);
  }
}

@Injectable()
export class WorkspaceModule extends BrowserModule {
  providers = [WorkspaceContribution];
  contributionProvider = [CommandContribution, ClientAppContribution];
}