// UIKit 内部入口：只转发 UIKit 需要的常量，避免 UIKit 直接依赖 SDK 内部实现路径。
export { ORG_CHILD_PERSON, ORG_CHILD_TAG, STATUS_DELETED } from './constants';
export {
  DEFAULT_FORWARD_MAX_ITEMS,
  DEFAULT_RECALL_WINDOW_SECONDS,
  DEFAULT_SYNC_BATCH_SIZE,
} from './internal/sdk-defaults';
