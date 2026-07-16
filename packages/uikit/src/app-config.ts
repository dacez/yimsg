import {
  DEFAULT_FORWARD_MAX_ITEMS,
  DEFAULT_RECALL_WINDOW_SECONDS,
  DEFAULT_SYNC_BATCH_SIZE,
} from '@yimsg/sdk/uikit-internal';

export const APP_CONFIG = Object.freeze({
  chat: Object.freeze({
    /** 每次加载的消息分页大小（条数）。 */
    messagePageSize: 30,
    /** 消息窗口最多保留多少页；超出按整页裁剪（30×5=150 条上限）。 */
    messagePageMaxPages: 5,
    /** 引用消息预览最大字符数。 */
    quotePreviewChars: 120,
    /**
    * 消息撤回时限认证前初始值（秒）。登录 / 鉴权成功后以后端 client_config 为准。
     * 默认读取 SDK 默认值（120 秒）。
     */
    recallWindowSeconds: DEFAULT_RECALL_WINDOW_SECONDS,
  }),
  list: Object.freeze({
    /** 会话 / 通讯录 / 群成员 / 转发候选 / 建群候选等列表每次拉取的分页大小（条数）。 */
    pageSize: 40,
    /** 列表窗口最多保留多少页；超出按整页裁剪（40×5=200 条上限）。 */
    maxPages: 5,
  }),
  forward: Object.freeze({
    /** 转发操作一次最多携带的消息条数。 */
    maxItems: DEFAULT_FORWARD_MAX_ITEMS,
    /** 转发弹窗最多选择的目标会话数。 */
    maxTargets: 500,
    /** 转发预览文本最大字符数。 */
    previewChars: 120,
    /** 转发弹窗预览块最多显示几条消息。 */
    modalPreviewItems: 5,
  }),
  memberPicker: Object.freeze({
    /** 建群成员选择最多选中的用户数。 */
    maxSelected: 500,
  }),
  sessionPrefs: Object.freeze({
    /** 屏蔽列表和免打扰同步每页拉取条数。 */
    pageSize: DEFAULT_SYNC_BATCH_SIZE,
  }),
  ui: Object.freeze({
    /**
      * 建群成员选择最大选中人数。
      * 大列表本身通过分页读取 + 有界列表窗口控制内存，不再用“加载到 500 后停止”的方式截断。
      */
    maxListItems: 500,
  }),
});
