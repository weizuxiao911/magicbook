/**
 * OpenType 拓展 — extensions/opentype/
 *
 * 重写 explorer 右键「打开方式... / 配置默认编辑器」:
 *   - 原生 OpenSumi 实现有 bug (file-tree-contribution.js):
 *     ① availableOpenTypes 取 currentEditorGroup 的 (当前激活资源, 文件未打开时是 welcome)
 *        → 打开方式列表混入 "欢迎", 且缺文本编辑器 (code);
 *     ② 点击「配置默认编辑器...」二次弹窗被焦点丢失立即关闭 (blur → onFocusLost → hide);
 *     ③ preferenceService.set 在 codeblitz 环境静默挂起 (providers 未就绪), 默认配置写不进去.
 *   - 本模块: 覆盖原生命令 'filetree.open.with' (菜单项不动, 点击走我们的实现):
 *     按右键文件 resolveEditorComponent 算打开方式 (文本编辑器兜底 + 过滤 welcome),
 *     二次弹窗 hide+defer 修复焦点, 配置默认编辑器 preference 超时后降级 localStorage,
 *     并通过高权重 resolver 在打开文件时应用默认编辑器.
 */
import { Injectable, Autowired } from '@opensumi/di';
import { Domain, URI, CommandRegistry, CommandContribution } from '@opensumi/ide-core-common';
import {
  BrowserModule,
  ClientAppContribution,
  QuickOpenService,
  QuickOpenItem,
  Mode,
  HideReason,
  PreferenceService,
} from '@opensumi/ide-core-browser';
import { FILE_COMMANDS } from '@opensumi/ide-core-browser/lib/common/common.command';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import type { IEditorOpenType, IResource } from '@opensumi/ide-editor';
import { BrowserEditorContribution, EditorComponentRegistry } from '@opensumi/ide-editor/lib/browser/types';
import { FileTreeModelService } from '@opensumi/ide-file-tree-next/lib/browser/services/file-tree-model.service';
import { Directory } from '@opensumi/ide-file-tree-next/lib/common/file-tree-node.define';

/** 默认编辑器关联 localStorage 键 (preference 写不进去时的降级持久化) */
const ASSOC_STORAGE_KEY = 'numas.editorAssociations';
const WELCOME_ID = 'webapp.welcome';

function readAssociations(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ASSOC_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAssociations(assoc: Record<string, string>): void {
  try {
    localStorage.setItem(ASSOC_STORAGE_KEY, JSON.stringify(assoc));
  } catch { /* 存储不可用忽略 */ }
}

@Injectable()
@Domain(BrowserEditorContribution, CommandContribution, ClientAppContribution)
export class OpenTypeContribution implements BrowserEditorContribution, CommandContribution, ClientAppContribution {
  @Autowired(WorkbenchEditorService)
  private readonly editorService: WorkbenchEditorService;

  @Autowired(FileTreeModelService)
  private readonly fileTreeModel: FileTreeModelService;

  @Autowired(QuickOpenService)
  private readonly quickOpenService: QuickOpenService;

  @Autowired(PreferenceService)
  private readonly preferenceService: PreferenceService;

  @Autowired(CommandRegistry)
  private readonly commandRegistry: CommandRegistry;

  private registry: EditorComponentRegistry | null = null;

  // ----- 打开文件时应用默认编辑器 (高权重 resolver, 优先于 file-scheme 原生 resolver) -----
  registerEditorComponent(registry: EditorComponentRegistry): void {
    this.registry = registry;
    registry.registerEditorComponentResolver((scheme) => (scheme === 'file' ? 100 : -1), (resource, results, resolve) => {
      const assoc = readAssociations();
      const glob = `*${resource.uri.path.ext}`;
      const compId = assoc[glob];
      if (!compId) return;
      // 已有关联编辑器 → 强制使用 (resolve 会 break 后续 resolver). 注意区分 type (code) 与组件 id.
      const hit = results.some((r) => (r as any).componentId === compId);
      if (!hit) {
        if (compId === 'code') {
          resolve([{ type: 'code' }]);
        } else {
          resolve([{ type: 'component', componentId: compId }]);
        }
      }
    });
  }

  // ----- 覆盖 OpenSumi 原生命令 (菜单项不变, 点击走这里) -----
  registerCommands(commands: CommandRegistry): void {
    // OpenSumi registerCommand 对已注册命令直接拒绝, 必须先 unregister
    try { commands.unregisterCommand(FILE_COMMANDS.OPEN_TYPE_WITH.id); } catch { /* */ }
    commands.registerCommand(FILE_COMMANDS.OPEN_TYPE_WITH, {
      execute: () => this.openTypeFlow(),
    });
  }

  onStart(): void {
    // 模块加载顺序不定: 若原生 file-tree-contribution 后注册, 会覆盖我们 — 启动后再覆盖一次确保生效
    setTimeout(() => {
      try {
        this.commandRegistry.unregisterCommand(FILE_COMMANDS.OPEN_TYPE_WITH.id);
        this.commandRegistry.registerCommand(FILE_COMMANDS.OPEN_TYPE_WITH, {
          execute: () => this.openTypeFlow(),
        });
        console.log('[opentype] 已接管 filetree.open.with (打开方式/配置默认编辑器)');
      } catch (e) {
        console.warn('[opentype] 命令覆盖失败:', e);
      }
    }, 0);
  }

  // ----- 打开方式流程 -----
  private async openTypeFlow(): Promise<void> {
    const ctxFile = this.fileTreeModel.contextMenuFile;
    if (!ctxFile?.uri || Directory.is(ctxFile)) return;
    const uri = ctxFile.uri;
    const openTypes = await this.resolveOpenTypes(uri);
    if (openTypes.length === 0) return;

    // VSCode Open With 风格: 每项 2 行 — label (打开方式名) + detail (描述)
    const makeItems = (run: (mode: number, item: IEditorOpenType) => boolean) =>
      openTypes.map(
        (item) =>
          new QuickOpenItem({
            label: openTypeLabel(item),
            detail: openTypeDetail(item),
            run: (mode) => run(mode, item),
          }),
      );

    const runOpen = (mode: number, item: IEditorOpenType): boolean => {
      if (mode !== Mode.OPEN) return false;
      void this.openWith(uri, item);
      return true;
    };

    const items = makeItems(runOpen);
    // 「配置默认编辑器...」: 二次弹窗选编辑器 → 写默认关联
    items.push(
      new QuickOpenItem({
        label: `为 "${uri.path.ext}" 配置默认编辑器...`,
        showBorder: true,
        run: (mode) => {
          if (mode !== Mode.OPEN) return false;
          // 焦点修复: 先关掉当前弹窗 (释放 item 焦点), 延迟再开, 否则 blur → onFocusLost → 新弹窗立即关闭
          this.quickOpenService.hide(HideReason.CANCELED);
          setTimeout(() => {
            const runSet = (m: number, item: IEditorOpenType): boolean => {
              if (m !== Mode.OPEN) return false;
              void this.setDefaultEditor(uri, item);
              return true;
            };
            this.openQuickOpen(makeItems(runSet), uri);
          }, 150);
          return true;
        },
      }),
    );
    this.openQuickOpen(items, uri);
  }

  private openQuickOpen(items: QuickOpenItem[], uri: URI): void {
    this.quickOpenService.open(
      { onType: (_, acceptor) => acceptor(items) },
      {
        fuzzyMatchLabel: true,
        ignoreFocusOut: false,
        placeholder: `为 "${uri.path.base}" 选择打开方式`,
      },
    );
  }

  /** 按右键文件算打开方式: resolveEditorComponent (file-scheme 给文本 code / 内置组件各按文件类型), 过滤 welcome.
   *  注: 不加"文本编辑器"兜底 — 二进制文件 (如 .pdf 有内置阅读器) 不该出现文本编辑器项
   *  (点了也打不开, 纯误导; file-scheme resolver 对文本文件自然会返回 code). */
  private async resolveOpenTypes(uri: URI): Promise<IEditorOpenType[]> {
    const resource: IResource = { uri, name: uri.path.base, icon: '' };
    let types: IEditorOpenType[] = [];
    if (this.registry) {
      try {
        types = await this.registry.resolveEditorComponent(resource);
      } catch { /* 解析失败 → 空列表 */ }
    }
    return types.filter((t) => (t as any).componentId !== WELCOME_ID);
  }

  /** 用指定打开方式打开文件 (未打开则先 open) */
  private async openWith(uri: URI, item: IEditorOpenType): Promise<void> {
    const group = this.editorService.currentEditorGroup;
    if (!group) return;
    const current = group.currentResource?.uri;
    if (!current || !current.isEqual(uri)) {
      await this.editorService.open(uri, { preview: false });
    }
    group.changeOpenType((item as any).componentId ?? item.type);
  }

  /** 写默认编辑器关联: preference 优先 (超时保护), 失败降级 localStorage; 当前文件立即应用 */
  private async setDefaultEditor(uri: URI, item: IEditorOpenType): Promise<void> {
    const glob = `*${uri.path.ext}`;
    const compId = (item as any).componentId ?? item.type;
    // 1. preference (codeblitz 环境可能永久挂起, 800ms 超时)
    try {
      await Promise.race([
        (async () => {
          const scope = this.preferenceService.resolve('workbench.editorAssociations')?.scope;
          const cur = this.preferenceService.get('workbench.editorAssociations') || {};
          await this.preferenceService.set('workbench.editorAssociations', { ...cur, [glob]: compId }, scope);
        })(),
        new Promise((r) => setTimeout(r, 800)),
      ]);
    } catch { /* preference 不可用 → 降级 */ }
    // 2. localStorage 降级 (resolver 打开文件时应用)
    const assoc = readAssociations();
    assoc[glob] = compId;
    writeAssociations(assoc);
    console.log('[opentype] 默认编辑器已配置:', glob, '→', compId);
    // 3. 当前文件立即用所选方式打开
    await this.openWith(uri, item);
  }
}

/** 已知编辑器组件描述 (VSCode Open With 第二行; 未知组件兜底 componentId). 内置拓展一律「内置」 */
const COMPONENT_DESCRIPTIONS: Record<string, string> = {
  'numas.pdf-reader': '内置',
  'numas.html-viewer': '内置',
  'webapp.welcome': '欢迎页',
};

/** 打开方式 label: code → 文本编辑器 (不用 OpenSumi 的 "代码"), 组件 → title/componentId */
function openTypeLabel(item: IEditorOpenType): string {
  if (item.type === 'code') return '文本编辑器';
  return item.title || (item as any).componentId || item.type;
}

/** 打开方式 detail (第二行描述) */
function openTypeDetail(item: IEditorOpenType): string {
  if (item.type === 'code') return '内置';
  const cid = (item as any).componentId;
  return COMPONENT_DESCRIPTIONS[cid] || (cid ? `拓展组件: ${cid}` : '');
}

@Injectable()
export class OpenTypeModule extends BrowserModule {
  providers = [OpenTypeContribution];
  contributionProvider = [BrowserEditorContribution, CommandContribution, ClientAppContribution];
}
