/**
 * vsix customEditor 根治 patch — web/src/patches/customEditors.js
 *
 * 根因: opensumi 的 createCustomEditorComponent 在 React 18 dev mode 的
 *       StrictEffects 双调用行为 (mount→unmount→mount) 下, useEffect 异步 .then()
 *       跑回来时 React ref 已被设 null, 挂载跳过, webview 永远不挂。
 *
 * 根治: 用 useRef 标记, useEffect 只跑一次, 避免双调用误触。
 *       webview 生命周期交给 main thread (web/src/dev/patch-custom-editor.ts)。
 *
 * 同步: webpack.config.js 的 resolve.alias 指向本文件代替 opensumi 原版。
 *       下次 npm install 后仍然有效, 不被 node_modules 改动覆盖。
 *
 * 对应 opensumi 源文件: web/node_modules/@opensumi/ide-extension/lib/browser/vscode/contributes/customEditors.js
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomEditorContributionPoint = void 0;
exports.createCustomEditorComponent = createCustomEditorComponent;
const tslib_1 = require("tslib");
const react_1 = tslib_1.__importDefault(require("react"));
const di_1 = require("@opensumi/di");
const ide_core_browser_1 = require("@opensumi/ide-core-browser");
const ide_core_common_1 = require("@opensumi/ide-core-common");
const browser_1 = require("@opensumi/ide-editor/lib/browser");
const ide_webview_1 = require("@opensumi/ide-webview");
const editor_webview_1 = require("@opensumi/ide-webview/lib/browser/editor-webview");
const common_1 = require("../../../common");
const custom_editor_1 = require("../../../common/vscode/custom-editor");
const types_1 = require("../../types");
let CustomEditorContributionPoint = class CustomEditorContributionPoint extends common_1.VSCodeContributePoint {
    constructor() {
        super(...arguments);
        this.options = new Map();
    }
    contribute() {
        for (const contrib of this.contributesMap) {
            const { extensionId, contributes } = contrib;
            contributes.forEach((c) => {
                this.registerSingleCustomEditor(c, extensionId);
            });
            this.addDispose(this.eventBus.on(custom_editor_1.CustomEditorOptionChangeEvent, (e) => {
                if (this.options.has(e.payload.viewType)) {
                    this.options.set(e.payload.viewType, e.payload.options);
                }
            }));
        }
    }
    getOptions(viewType) {
        return this.options.get(viewType) || {};
    }
    registerSingleCustomEditor(customEditor, extensionId) {
        try {
            const viewType = customEditor.viewType;
            this.options.set(customEditor.viewType, {});
            const componentId = `${ide_core_common_1.CUSTOM_EDITOR_SCHEME}-${customEditor.viewType}`;
            const component = createCustomEditorComponent(customEditor.viewType, componentId, () => this.getOptions(customEditor.viewType));
            const patterns = customEditor.selector.map((s) => s.filenamePattern).filter((p) => typeof p === 'string');
            if (patterns.length === 0) {
                return;
            }
            const priority = customEditor.priority || browser_1.IEditorPriority.default;
            this.addDispose(this.editorComponentRegistry.registerEditorComponentResolver(() => 10, (resource, results) => {
                for (const pattern of patterns) {
                    if ((0, ide_core_common_1.match)(pattern, resource.uri.path.toString().toLowerCase()) ||
                        (0, ide_core_common_1.match)(pattern, resource.uri.path.base.toLowerCase())) {
                        results.push({
                            componentId,
                            type: browser_1.EditorOpenType.component,
                            title: customEditor.displayName
                                ? this.getLocalizeFromNlsJSON(customEditor.displayName, extensionId)
                                : customEditor.viewType,
                            weight: priority === browser_1.IEditorPriority.default ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER,
                            priority,
                            saveResource: (resource) => this.eventBus.fireAndAwait(new custom_editor_1.CustomEditorShouldSaveEvent({
                                uri: resource.uri,
                                viewType,
                                cancellationToken: new ide_core_common_1.CancellationTokenSource().token,
                            })),
                            revertResource: (resource) => this.eventBus.fireAndAwait(new custom_editor_1.CustomEditorShouldRevertEvent({
                                uri: resource.uri,
                                viewType,
                                cancellationToken: new ide_core_common_1.CancellationTokenSource().token,
                            })),
                            undo: (resource) => this.eventBus.fireAndAwait(new custom_editor_1.CustomEditorShouldEditEvent({
                                uri: resource.uri,
                                viewType,
                                type: 'undo',
                            })),
                            redo: (resource) => this.eventBus.fireAndAwait(new custom_editor_1.CustomEditorShouldEditEvent({
                                uri: resource.uri,
                                viewType,
                                type: 'redo',
                            })),
                        });
                    }
                }
            }));
            this.addDispose(this.editorComponentRegistry.registerEditorComponent({
                uid: componentId,
                component,
                metadata: {
                    customEditor: viewType,
                },
            }));
        }
        catch (e) {
            this.logger.error(e);
        }
    }
};
exports.CustomEditorContributionPoint = CustomEditorContributionPoint;
tslib_1.__decorate([
    (0, di_1.Autowired)(browser_1.EditorComponentRegistry),
    tslib_1.__metadata("design:type", browser_1.EditorComponentRegistry)
], CustomEditorContributionPoint.prototype, "editorComponentRegistry", void 0);
tslib_1.__decorate([
    (0, di_1.Autowired)(ide_core_common_1.ILogger),
    tslib_1.__metadata("design:type", Object)
], CustomEditorContributionPoint.prototype, "logger", void 0);
tslib_1.__decorate([
    (0, di_1.Autowired)(ide_core_browser_1.IEventBus),
    tslib_1.__metadata("design:type", Object)
], CustomEditorContributionPoint.prototype, "eventBus", void 0);
exports.CustomEditorContributionPoint = CustomEditorContributionPoint = tslib_1.__decorate([
    (0, di_1.Injectable)(),
    (0, common_1.Contributes)('customEditors'),
    (0, common_1.LifeCycle)(2 /* LifeCyclePhase.Initialize */)
], CustomEditorContributionPoint);
function createCustomEditorComponent(viewType, openTypeId, getOptions) {
    return ({ resource }) => {
        const activationEventService = (0, ide_core_browser_1.useInjectable)(types_1.IActivationEventService);
        const webviewService = (0, ide_core_browser_1.useInjectable)(ide_webview_1.IWebviewService);
        const eventBus = (0, ide_core_browser_1.useInjectable)(ide_core_browser_1.IEventBus);
        const extensionService = (0, ide_core_browser_1.useInjectable)(common_1.ExtensionService);
        // ★ 根治: useRef 标记, 避免 React 18 dev mode StrictEffects 双调用导致重复 mount/cleanup
        const __hasFiredRef = react_1.default.useRef(false);
        const __disposerRef = react_1.default.useRef(null);
        const __tokenRef = react_1.default.useRef(null);
        react_1.default.useEffect(() => {
            if (__hasFiredRef.current) {
                // React 双调用的第二次, 跳过 (mount/cleanup 都跳过)
                return undefined;
            }
            __hasFiredRef.current = true;
            const cancellationTokenSource = new ide_core_common_1.CancellationTokenSource();
            const disposer = new ide_core_common_1.Disposable();
            __disposerRef.current = disposer;
            __tokenRef.current = cancellationTokenSource;
            Promise.all([
                activationEventService.fireEvent('onCustomEditor', viewType),
                extensionService.eagerExtensionsActivated.promise,
            ]).then(() => {
                if (cancellationTokenSource.token.isCancellationRequested) return;
                const webview = webviewService.createWebview(getOptions().webviewOptions);
                if (!webview) return;
                // 只 fire event, mount/cleanup 由 main thread (web/src/dev/patch-custom-editor.ts) 接管
                disposer.addDispose({
                    dispose: () => {
                        eventBus.fire(new custom_editor_1.CustomEditorShouldHideEvent({ uri: resource.uri, viewType }));
                    },
                });
                eventBus.fire(new custom_editor_1.CustomEditorShouldDisplayEvent({
                    uri: resource.uri,
                    viewType,
                    webviewPanelId: webview.id,
                    cancellationToken: cancellationTokenSource.token,
                    openTypeId,
                }));
            }).catch((e) => { console.error('[customEditor] promise error', e); });
            // 不返回 cleanup (避免双调用 cleanup 误调), 由 patch 接管 hide 事件
            return undefined;
        }, []);
        return (react_1.default.createElement("div", { style: { height: '100%', width: '100%', position: 'relative' }, className: 'editor-webview-webview-component' }));
    };
}
//# sourceMappingURL=customEditors.js.map