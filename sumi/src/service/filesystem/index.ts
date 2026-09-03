/**
 * service/filesystem/index.ts — 公共 API barrel
 *
 * 对外导出: 接口契约 + DI token + DI module + provider 注册.
 * impl 在 ./filesystem.service.ts (DI 单例), provider 在 ./provider.ts (DI 接入 codeblitz).
 *
 * 消费方: useInjectable(FsToken) 拿单例; FsModule 注册到 modules.ts.
 */

export type { FsEntry, FileMeta, IFileSystem } from './filesystem.interface';
export { FsToken } from './filesystem.interface';
export { FsModule } from './filesystem.service';
export { CustomFsProviderContribution as FsProviderContribution } from './provider';
export { FsProviderModule } from './provider';