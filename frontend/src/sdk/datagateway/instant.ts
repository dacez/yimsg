import { BaseDataGateway } from "./base";

/**
 * InstantDataGateway — instant 模式（纯内存）DataGateway。
 *
 * instant 模式不保存本地副本、不维护同步游标：读取一律直连后端，
 * messages:received 按累积的通知 msg_id 批量直读内容供 onMessages，
 * 通讯录变更只发重绘信号。这些恰好就是 BaseDataGateway 的默认（基线）行为，
 * 故本类目前无需任何额外逻辑；保留独立文件是为将来 instant 专属逻辑预留落点。
 */
export class InstantDataGateway extends BaseDataGateway {}
