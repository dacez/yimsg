export type ClientMode = 'memory' | 'persistent';
/** 启动页可选布局偏好。'auto' 表示根据视口/指针类型自动判定。 */
export type LayoutChoice = 'desktop' | 'mobile' | 'auto';
/** 实际应用的布局值，只有两种。 */
export type ResolvedLayout = 'desktop' | 'mobile';

export type { StorageAdapter } from './storage-base';
