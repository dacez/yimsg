import type { ClientTransport } from '../transport/connection';

/** MessageCodec 封装 protobuf 消息的构造、编码与解码能力。
 *  实现者为 generated/yimsg.ts 中自动生成的 MessageFns 对象。 */
export interface MessageCodec<T = unknown> {
  encode(message: T, writer?: { fork(): unknown }): { finish(): Uint8Array };
  decode(input: Uint8Array): T;
  create(base?: Partial<T>): T;
}

/**
 * sendProtoAction 是出方向 action 的唯一底层发送点：按 Type + request/response codec
 * 编码并交给 transport.sendBinary。生成物 `actions.gen.ts` 直接复用本函数，业务整形
 * （target、分页、msg_id 等）由 `action-mappers.ts` 工具完成后再传入。
 */
export function sendProtoAction<TReq, TResp>(
  transport: ClientTransport,
  typeId: number,
  requestCodec: MessageCodec<TReq>,
  request: Partial<TReq>,
  responseCodec: MessageCodec<TResp>,
): Promise<TResp> {
  const body = requestCodec.encode(requestCodec.create(request)).finish();
  return transport.sendBinary(typeId, body, responseCodec);
}
