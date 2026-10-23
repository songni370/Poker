<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import { copyText } from './clipboard.ts'

/**
 * 邀请朋友弹窗：把房间号与邀请链接摆出来给朋友。
 *
 * 复制策略（局域网明文部署也要可用）：
 *   - 有 `navigator.clipboard` → 直接写剪贴板，反馈「已复制…」；
 *   - 没有（http://192.168.x.x:3000）→ 把文字选中并提示按 Ctrl/⌘ + C，
 *     绝不让按钮看起来「点了没反应」。
 *
 * 组件只负责展示与复制，房间号 / 链接由父组件算好后传入。
 */
const props = defineProps<{
  /** 是否显示。 */
  visible: boolean
  /** 6 位数字房间号。 */
  roomCode: string
  /** 完整邀请链接。 */
  inviteLink: string
}>()

const emit = defineEmits<{ (event: 'update:visible', value: boolean): void }>()

const codeText = ref<HTMLElement | null>(null)
const linkField = ref<{ $el?: HTMLInputElement } | null>(null)
const copyStatus = ref('')

/** 关闭或再次打开时清掉上一次的复制反馈，免得回来看到过期的「已复制」。 */
watch(
  () => props.visible,
  () => {
    copyStatus.value = ''
  },
)

/**
 * 复制房间号 / 邀请链接。
 * 成功 → 「已复制…」；没有剪贴板 API → 选中文字 + 「已选中，按 Ctrl/⌘ + C 复制」。
 */
async function copyInvite(kind: 'link' | 'code'): Promise<void> {
  const text = kind === 'link' ? props.inviteLink : props.roomCode
  if ((await copyText(text)) === 'copied') {
    copyStatus.value = kind === 'link' ? '已复制邀请链接' : '已复制房间号'
    return
  }
  // 退路：把要复制的内容选中，用户手动按快捷键即可
  await nextTick()
  if (kind === 'link') {
    linkField.value?.$el?.focus()
    linkField.value?.$el?.select()
  } else if (codeText.value) {
    const range = document.createRange()
    range.selectNodeContents(codeText.value)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  copyStatus.value = '已选中，按 Ctrl/⌘ + C 复制'
}

/** 链接框一获得焦点就全选：这样手按 Ctrl/⌘ + C 也能复制（见 copyInvite 的退路）。 */
function selectLinkValue(event: Event): void {
  const input = event.target as HTMLInputElement
  input.select()
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :dismissable-mask="true"
    class="vip-dialog vip-hub-dialog"
    :style="{ width: 'min(92vw, 560px)' }"
    header="邀请朋友"
    @update:visible="(value: boolean) => emit('update:visible', value)"
  >
    <div class="invite-pane">
      <div class="invite-banner">
        <i class="pi pi-sparkles invite-icon" aria-hidden="true" />
        <div class="invite-banner-texts">
          <h4 class="invite-title">邀请好友同桌竞技</h4>
          <p class="invite-desc">支持局域网或内网直连，分享房间号或链接即可快速加入</p>
        </div>
      </div>

      <div class="invite-card">
        <span class="invite-label">房间号</span>
        <div class="invite-code-box">
          <b ref="codeText" class="invite-code num">{{ roomCode }}</b>
          <Button size="small" outlined class="copy-btn" title="复制房间号" @click="copyInvite('code')">
            <i class="pi pi-copy" aria-hidden="true" />
            <span>复制</span>
          </Button>
        </div>
      </div>

      <div class="invite-card">
        <span class="invite-label">专属邀请直链</span>
        <div class="invite-input-row">
          <InputText
            ref="linkField"
            :value="inviteLink"
            readonly
            class="invite-link-input"
            aria-label="房间直链"
            @focus="selectLinkValue"
          />
          <Button severity="help" class="copy-btn" :title="'复制完整链接'" @click="copyInvite('link')">
            <i class="pi pi-copy" aria-hidden="true" />
            <span>复制链接</span>
          </Button>
        </div>
      </div>

      <p v-if="copyStatus" class="copy-status" role="status">
        <i class="pi pi-check" aria-hidden="true" />
        <span>{{ copyStatus }}</span>
      </p>
    </div>
  </Dialog>
</template>

<style scoped>
/* 拟物：邀请面板沿用皮革 + 黄铜的材质语言 */
.invite-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.invite-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid #8a6a32;
  background: linear-gradient(180deg, #3a2e1c 0%, #241a10 60%, #160f09 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 230, 170, 0.22),
    inset 0 -2px 6px rgba(0, 0, 0, 0.7),
    0 4px 14px rgba(0, 0, 0, 0.5);
}

.invite-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  flex: none;
  border-radius: 999px;
  font-size: 1rem;
  color: #3a2a12;
  background: radial-gradient(circle at 32% 26%, #f6e2b4 0%, #d3b070 45%, #8c6c33 100%);
  border: 1px solid #6d5325;
  box-shadow:
    inset 0 -2px 3px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.7);
}

.invite-banner-texts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.invite-title {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 800;
  color: #ffdf9a;
  text-shadow: 0 1px 0 #000;
}

.invite-desc {
  margin: 0;
  font-size: 0.76rem;
  color: #a08f74;
}

/* 内凹信息槽 */
.invite-card {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid rgba(0, 0, 0, 0.8);
  border-radius: 12px;
  background: linear-gradient(180deg, #1d1610 0%, #120d09 100%);
  box-shadow:
    inset 0 2px 6px rgba(0, 0, 0, 0.8),
    0 1px 0 rgba(255, 255, 255, 0.05);
}

.invite-label {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #cbbd9f;
}

.invite-code-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: linear-gradient(180deg, #120d09 0%, #1d1610 100%);
  border: 1px solid rgba(0, 0, 0, 0.9);
  border-radius: 10px;
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.85);
}

.invite-code {
  font-family: var(--font-display);
  font-size: 2rem;
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: 0.16em;
  text-indent: 0.16em;
  color: #ffdf9a;
  text-shadow: 0 1px 0 #000, 0 0 16px rgba(255, 190, 90, 0.4);
}

.invite-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.invite-link-input {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.82rem;
}

.copy-btn {
  flex: none;
  min-height: 34px;
  border-radius: 9px !important;
  background: linear-gradient(180deg, #3b2f22 0%, #241b12 100%) !important;
  border: 1px solid rgba(0, 0, 0, 0.75) !important;
  color: #f1e6d0 !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    inset 0 -2px 4px rgba(0, 0, 0, 0.6),
    0 2px 4px rgba(0, 0, 0, 0.5) !important;
}

.copy-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-height: 1.2em;
  font-size: 0.82rem;
  font-weight: 700;
  color: #8fe0a8;
}

/* 窄屏：房间号与复制按钮分两行，链接框独占一行 */
@media (max-width: 420px) {
  .invite-code-box {
    flex-wrap: wrap;
    justify-content: center;
    row-gap: 8px;
  }

  .invite-code {
    font-size: 1.7rem;
  }

  .invite-input-row {
    flex-wrap: wrap;
  }

  .invite-link-input,
  .copy-btn {
    flex: 1 1 100%;
  }
}
</style>
