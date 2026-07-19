/**
 * 有界列表刷新契约：会话列表、当前会话消息、好友/请求列表等所有"有界列表"
 * 通过 invalidate() 注册自己的追平动作。invalidate 语义等价于"收到一条属于本列表
 * 的新数据通知"——具体是立即重拉追平还是推迟（点亮"有更新"提示），由各列表
 * 自己按贴顶/可见性规则决定，与新会话、新消息、新联系人通知触发的动作完全一致。
 * 调用方（例如重连成功）只管广播 invalidate，不需要感知具体是哪些列表。
 */
export interface BoundedListController {
  readonly id: string;
  invalidate(): void | Promise<void>;
}
