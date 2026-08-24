/**
 * 模型管理配置 — 按用户本地存储
 *
 * 字段:
 *   - order: ModelID[]        自定义模型展示顺序
 *   - hidden: ModelID[]       隐藏不展示的模型
 *   - customNames: {[id]: name} 重命名 (本地别名, 不影响后端)
 *   - groups: { [groupID]: ModelID[] } 自定义分组
 *   - default: ModelID         默认模型 (无 currentModel 时用)
 *   - providerLabels: { [providerID]: string } 覆盖 provider 标题 (如 'opencode' → 'OpenCode Zen')
 */

const STORAGE_KEY = 'chat.modelPrefs.v1';

export interface ModelPrefs {
  order: string[];           // modelID list
  hidden: string[];
  customNames: Record<string, string>;
  groups: Record<string, string[]>; // groupID -> modelIDs
  groupOrder: string[];      // 自定义分组顺序
  groupLabels: Record<string, string>;
  default: string;
  defaultProvider: string;   // 默认模型所在 provider (同名模型跨 provider 精确定位)
  providerLabels: Record<string, string>;
}

const DEFAULTS: ModelPrefs = {
  order: [],
  hidden: [],
  customNames: {},
  groups: {},
  groupOrder: [],
  groupLabels: {},
  default: '',
  defaultProvider: '',
  providerLabels: {},
};

function load(): ModelPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(prefs: ModelPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('chat:ai-modelPrefs-changed'));
}

let cache: ModelPrefs | null = null;

function get() {
  if (!cache) cache = load();
  return cache;
}

function set(next: ModelPrefs) {
  cache = next;
  save(next);
}

export const modelPrefs = {
  get,
  set,

  /** 重排序 — 把 from 移到 to 之前 */
  reorder(modelID: string, toIndex: number) {
    const p = { ...get() };
    p.order = p.order.filter((x) => x !== modelID);
    p.order.splice(toIndex, 0, modelID);
    set(p);
  },

  toggleHidden(modelID: string) {
    const p = { ...get() };
    if (p.hidden.includes(modelID)) {
      p.hidden = p.hidden.filter((x) => x !== modelID);
    } else {
      p.hidden = [...p.hidden, modelID];
    }
    set(p);
  },

  setName(modelID: string, name: string) {
    const p = { ...get() };
    p.customNames = { ...p.customNames, [modelID]: name };
    set(p);
  },

  setDefault(modelID: string, providerID?: string) {
    const p = { ...get() };
    p.default = modelID;
    if (providerID) p.defaultProvider = providerID;
    set(p);
  },

  setProviderLabel(providerID: string, label: string) {
    const p = { ...get() };
    p.providerLabels = { ...p.providerLabels, [providerID]: label };
    set(p);
  },

  createGroup(name: string): string {
    const p = { ...get() };
    const id = `g-${Date.now().toString(36)}`;
    p.groups = { ...p.groups, [id]: [] };
    p.groupOrder = [...p.groupOrder, id];
    p.groupLabels = { ...p.groupLabels, [id]: name };
    set(p);
    return id;
  },

  renameGroup(groupID: string, name: string) {
    const p = { ...get() };
    p.groupLabels = { ...p.groupLabels, [groupID]: name };
    set(p);
  },

  deleteGroup(groupID: string) {
    const p = { ...get() };
    p.groups = Object.fromEntries(
      Object.entries(p.groups).filter(([k]) => k !== groupID)
    );
    p.groupOrder = p.groupOrder.filter((k) => k !== groupID);
    p.groupLabels = Object.fromEntries(
      Object.entries(p.groupLabels).filter(([k]) => k !== groupID)
    );
    set(p);
  },

  moveToGroup(modelID: string, groupID: string | null) {
    const p = { ...get() };
    // 从所有分组中移除
    const newGroups: Record<string, string[]> = {};
    for (const [k, ids] of Object.entries(p.groups)) {
      newGroups[k] = ids.filter((x) => x !== modelID);
    }
    // 加入新分组
    if (groupID) {
      newGroups[groupID] = [...(newGroups[groupID] || []), modelID];
    }
    p.groups = newGroups;
    set(p);
  },

  reorderGroup(groupID: string, modelIDs: string[]) {
    const p = { ...get() };
    p.groups = { ...p.groups, [groupID]: modelIDs };
    set(p);
  },

  reset() {
    cache = { ...DEFAULTS };
    save(cache);
  },
};
