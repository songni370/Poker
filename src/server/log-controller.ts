import { LogController } from 'fastify'

/**
 * 关闭 Fastify 的「每个请求两行」日志。
 *
 * 为什么不用 `disableRequestLogging`：Fastify 5.12 起该顶层选项已标记 deprecated
 * （启动时会打印 FSTDEP023 警告，`fastify@6` 会移除），官方给的替代就是本文件这种做法——
 * 传一个 `LogController` 实例并把 `disableRequestLogging` 打开。
 *
 * 请求级日志被关掉后，日志里只会留下**业务事件**（建房/结算/房间回收）与错误，
 * 具体见 logger.ts 顶部的说明。
 */
export class QuietRequestLogger extends LogController {
  constructor() {
    super({ disableRequestLogging: true })
  }
}
