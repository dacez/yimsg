// 有界列表的宿主注册契约。
//
// 这里只有类型：注册表实体由宿主自己持有（见 app-instance.ts 的 registerBoundedList /
// invalidateBoundedLists），组件通过必填的 BoundedListOptions.register 接进去。
//
// 曾经这里还有一份进程级 Map 和 invalidateAllBoundedLists() 广播函数，作为不传 register
// 时的退化路径。它有两个问题：同一页面并存多个 AppInstance 时同名列表会互相覆盖（模块
// 自己的注释就在警告不要用它），而广播函数在生产代码里从未被调用——落进那份 Map 的实例
// 只进不出也收不到任何通知。整体删除，register 改为必填。

import type { RegisterBoundedList } from './types';

/** 宿主侧可被「有新数据」通知唤醒的对象。 */
export interface Invalidatable {
  readonly id: string;
  invalidate(): void | Promise<void>;
}

/**
 * 宿主侧的有界列表刷新契约（历史名字，等价于 Invalidatable）：
 * 会话列表、当前会话消息、好友/请求列表等所有「有界列表」通过 invalidate()
 * 注册自己的追平动作。invalidate 语义等价于「收到一条属于本列表的新数据通知」——
 * 具体是立即重拉追平还是推迟（点亮「有更新」提示），由各列表自己按贴顶/可见性
 * 规则决定。调用方（例如重连成功）只管广播 invalidate。
 */
export type BoundedListController = Invalidatable;

/**
 * 显式声明「本列表不接入宿主的重连广播」。
 *
 * 用于模态框内的一次性候选列表：它们随弹窗创建、随弹窗 dispose，生命周期比一次重连
 * 还短，被广播追平没有意义。写成具名常量而不是省略 `register`，是为了让「不注册」
 * 成为可 grep、可复核的显式决定，而不是漏写参数的副作用。
 */
export const standaloneList: RegisterBoundedList = () => () => {};
