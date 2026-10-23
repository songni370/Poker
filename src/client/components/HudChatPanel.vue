<script setup lang="ts">
import { computed } from 'vue'
import { CHAT_MAX_LENGTH } from '../../shared/protocol.ts'
import { useHudPanelsContext } from '../composables/useHudPanels.ts'

/**
 * 牌桌 HUD「聊天」浮层。
 *
 * 状态与交互全部来自 `useHudPanels()`——由父组件创建一次后 provide 下来，
 * 这里 inject 复用**同一个实例**（不能让组件自己再调一次，否则展开状态会分成两份）。
 */
const {
  chat,
  chatOpen,
  chatInputRef,
  chatListRef,
  draft,
  error,
  composing,
  canSend,
  unreadText,
  chatAria,
  toggleChat,
  onChatScroll,
  onSenderClick,
  submitChat,
  onChatKeydown,
  mentionsMe,
  isChatContinuation,
} = useHudPanelsContext()

defineProps<{ heroPlayerId: string | null }>()

/**
 * 时间交给 Intl 格式化，不硬编码 HH:mm。
 * 界面语言固定为简体中文（<html lang="zh-CN">），这里显式指定区域，
 * 避免浏览器区域是 en-US 时出现「06:48 PM」这类与界面不一致的格式。
 */
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
function chatTime(at: number): string {
  return Number.isFinite(at) ? timeFormat.format(at) : ''
}

const maxLength = computed(() => CHAT_MAX_LENGTH)
</script>

<template>
  <aside class="hud-anchor hud-chat-anchor" aria-label="牌桌快捷聊天">
    <button
      type="button"
      class="hud-capsule-btn hud-chat-pill"
      :class="{ 'is-active': chatOpen }"
      :title="chatOpen ? '收起聊天' : '展开聊天'"
      :aria-label="chatAria"
      :aria-expanded="chatOpen"
      @click="toggleChat"
    >
      <i class="pi pi-comments hud-capsule-icon" aria-hidden="true" />
      <span class="hud-capsule-label">聊天</span>
      <span v-if="chat.unread > 0" class="hud-capsule-badge num">{{ unreadText }}</span>
      <i :class="chatOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'" class="hud-capsule-arrow" aria-hidden="true" />
    </button>

    <Transition name="hud-popover">
      <div v-show="chatOpen" class="hud-popover hud-chat-popover">
        <header class="hud-popover-header">
          <div class="hud-popover-title">
            <i class="pi pi-comments" aria-hidden="true" />
            <span>牌桌聊天</span>
            <span v-if="chat.unread > 0" class="hud-popover-badge num">{{ unreadText }}</span>
          </div>
          <button type="button" class="hud-popover-close-btn" title="收起聊天" aria-label="收起聊天" @click="toggleChat">
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </header>

        <div class="hud-chat-body">
          <div
            ref="chatListRef"
            class="hud-chat-list thin-scroll"
            role="log"
            aria-live="polite"
            aria-label="聊天消息"
            @scroll.passive="onChatScroll"
          >
            <div v-if="chat.messages.length === 0" class="hud-chat-empty">
              <span>暂无消息，打个招呼吧~</span>
            </div>
            <!-- 未读分隔线：打开聊天时记录锚点，重新打开后锚点之后的消息就是「新消息」。 -->
            <template v-for="msg in chat.messages" :key="msg.id">
              <div v-if="msg.id === chat.firstUnreadId" class="hud-chat-divider">
                <span>以下为新消息</span>
              </div>
              <div
                class="hud-chat-item"
                :class="{
                  'is-own': msg.playerId === heroPlayerId,
                  'is-system': msg.kind === 'system',
                  'is-mention': mentionsMe(msg),
                  'is-new': chat.isAfterReadAnchor(msg),
                  'is-continuation': isChatContinuation(msg),
                }"
                :title="chatTime(msg.at)"
              >
                <template v-if="msg.kind === 'system'">
                  <span class="hud-msg-system">📢 {{ msg.text }}</span>
                </template>
                <template v-else>
                  <!-- 同一个人连续发言只显示一次昵称：分组只影响视觉，消息文本里仍带昵称给读屏。 -->
                  <span
                    v-if="!isChatContinuation(msg)"
                    class="hud-msg-sender"
                    :title="`点击 @${msg.nickname}`"
                    @click="onSenderClick(msg.nickname)"
                  >
                    {{ msg.playerId === heroPlayerId ? '你' : msg.nickname }}:
                  </span>
                  <span v-else class="sr-only">{{ msg.playerId === heroPlayerId ? '你' : msg.nickname }}：</span>
                  <span class="hud-msg-text">{{ msg.text }}</span>
                </template>
              </div>
            </template>
          </div>

          <form class="hud-chat-form" @submit.prevent="submitChat">
            <input
              ref="chatInputRef"
              v-model="draft"
              type="text"
              class="hud-chat-input"
              :maxlength="maxLength"
              placeholder="说点什么… (Enter)"
              autocomplete="off"
              @keydown="onChatKeydown"
              @compositionstart="composing = true"
              @compositionend="composing = false"
              @input="error = ''"
            />
            <button
              type="submit"
              class="hud-chat-send"
              :disabled="!canSend"
              :title="canSend ? '发送消息' : '请输入消息'"
            >
              <i class="pi pi-send" aria-hidden="true" />
            </button>
          </form>
          <p v-if="error" class="hud-chat-error" role="alert">{{ error }}</p>
        </div>
      </div>
    </Transition>
  </aside>
</template>
