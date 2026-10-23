/**
 * 牌桌几何的唯一来源。
 *
 * 座位锚点、中央安全区宽度、公共牌尺寸与舞台留白都集中在这里，
 * CSS 只通过 `--seat-gap` / `--stage-pad-*` 这类变量消费，不再各自写死数值。
 *
 * 改动顺序建议：
 *   1. 调这里的档位常量；
 *   2. 跑 `npm run probe:table` 看重叠像素；
 *   3. 跑 `npx playwright test tests/e2e/poker-room.spec.ts -g 几何`。
 */

/** 座位椭圆横向/纵向半径（相对桌面宽高的百分比）。 */
export interface SeatAnchor {
  /** 横向半径百分比（43 表示「离桌心 43% 桌宽」）。 */
  x: number
  /** 纵向半径百分比。 */
  y: number
}

/** 桌面几何档位：按视口归类，后写的档位覆盖先写的。 */
export interface TableGeometryTier {
  /** 档位名，只用于注释与调试。 */
  name: string
  /** 命中该档位的媒体查询（空字符串 = 基础档）。 */
  query: string
  /** 桌面宽 / 高（CSS 值）。 */
  width: string
  height: string
  /** 座位椭圆半径。 */
  anchor: SeatAnchor
  /** 座位面板宽度。 */
  seatWidth: string
  /** 贴边座位面板宽度（左右两列更窄）。 */
  sideSeatWidth: string
  /** 座位面板纵向内边距。 */
  seatPaddingBlock: string
  /** 中央列左右各需要的净宽（座位 + 徽章 + 呼吸），用于 `max-width` 计算。 */
  centerInset: number
  /** 公共牌宽度（五张 + 牌距要装进中央列）。 */
  boardCardWidth: string
  /** 中央列纵向位置。 */
  centerTop: string
  /**
   * 中央列纵向安全边距（px）：中央列最多占到「桌面高度 - 2×inset」，
   * 给上下两排座位留出净空。桌面变矮时比单纯调 centerTop 更可靠。
   */
  centerMaxHeightInset: number
}

/** 桌面级变量：所有档位共享的材质与结构尺寸。 */
export interface TableBaseGeometry {
  /** 皮革包边宽度（桌面外圈）。 */
  railWidth: number
  /** 舞台留白：上下左右。 */
  stagePadding: { top: number; right: number; bottom: number; left: number }
  /** 桌面最大高度（竖屏档防止平板把桌子拉太高）。 */
  maxHeight: number
}

/**
 * 竖屏牌桌档位表。
 *
 * 这些数字都有实测依据（见各条注释），不要为了「看起来整齐」随手改。
 */
export const TABLE_GEOMETRY: readonly TableGeometryTier[] = [
  {
    name: 'portrait-base',
    query: '(max-width: 560px) and (orientation: portrait)',
    width: 'calc(100vw - 16px)',
    height: '100%',
    /*
     * 座位椭圆半径：把座位往桌沿推，给中央的底池/公共牌让出净空。
     * 之前 43/44 时，侧边座位面板与公共牌在纵向上几乎贴着（用户反馈「在同一层」）。
     */
    /*
     * 座位椭圆半径。纵向从 47 收到 44：座位面板是固定像素高（~51px），
     * 锚在下沿时面板中心到桌沿的距离不够，顶部座位的上沿会被桌面裁掉
     * （实测 seatTop=5px，几乎贴边）；本人座位的下沿则会超出桌面。
     */
    anchor: { x: 46, y: 44 },
    /* 座位宽度不能太窄：昵称会被截成「老…」这种，读不出是谁。
       半径推到 46/47 之后，桌沿空间够用，宽度回退到接近原来的值。 */
    seatWidth: 'clamp(80px, 21vw, 92px)',
    sideSeatWidth: 'clamp(74px, 19vw, 84px)',
    seatPaddingBlock: '4px',
    /*
     * 对称槽位下左右座位锚在 8% / 92%，但座位面板是固定像素宽（~82px）。
     * 桌面宽 374px 时，8% ≈ 30px，面板右沿到 71px —— 中央列必须从 71px 之后开始。
     * centerInset 是「左右各留多少」，所以取值要覆盖 面板半宽 + 锚点偏移：
     * 实测 208px 时中央区左沿仍在 112px、被座位压住 23px，这里加大到 236px。
     */
    centerInset: 176,
    boardCardWidth: 'clamp(24px, calc((100vw - 210px) / 5), 38px)',
    centerTop: '45%',
    centerMaxHeightInset: 86,
  },
  {
    // 360×740 这类矮机：座位面板再收 1px/边，换掉最后那点互压。
    name: 'portrait-short',
    query: '(max-width: 560px) and (orientation: portrait) and (max-height: 780px)',
    width: 'calc(100vw - 16px)',
    height: '100%',
    /*
     * 座位椭圆半径：把座位往桌沿推，给中央的底池/公共牌让出净空。
     * 之前 43/44 时，侧边座位面板与公共牌在纵向上几乎贴着（用户反馈「在同一层」）。
     */
    anchor: { x: 46, y: 44 },
    /* 座位宽度不能太窄：昵称会被截成「老…」这种，读不出是谁。
       半径推到 46/47 之后，桌沿空间够用，宽度回退到接近原来的值。 */
    seatWidth: 'clamp(80px, 21vw, 92px)',
    sideSeatWidth: 'clamp(74px, 19vw, 84px)',
    seatPaddingBlock: '3px',
    /*
     * 对称槽位下左右座位锚在 8% / 92%，但座位面板是固定像素宽（~82px）。
     * 桌面宽 374px 时，8% ≈ 30px，面板右沿到 71px —— 中央列必须从 71px 之后开始。
     * centerInset 是「左右各留多少」，所以取值要覆盖 面板半宽 + 锚点偏移：
     * 实测 208px 时中央区左沿仍在 112px、被座位压住 23px，这里加大到 236px。
     */
    centerInset: 176,
    boardCardWidth: 'clamp(24px, calc((100vw - 210px) / 5), 38px)',
    centerTop: '45%',
    centerMaxHeightInset: 82,
  },
  {
    // 超短屏：9 人环放不下，切「紧凑牌桌」两列布局（见 compactSeatStyle）。
    name: 'compact',
    query: '(max-width: 360px) and (max-height: 620px)',
    width: 'calc(100vw - 16px)',
    height: '100%',
    anchor: { x: 43, y: 22 },
    seatWidth: '62px',
    sideSeatWidth: '62px',
    seatPaddingBlock: '1px',
    centerInset: 170,
    boardCardWidth: 'clamp(20px, calc((100vw - 200px) / 5), 28px)',
    // 紧凑档桌面极矮（~125px），本人座位贴在桌下沿中央：
    // 中央列上移到 36%，把底下那点净空留给本人座位。
    centerTop: '36%',
    // 紧凑档是「两列座位夹中央列」的布局，中央列本来就避开座位，不再加纵向约束
    // （桌面只有 ~107px，再加 34px 边距会把底池与公共牌压到放不下）。
    centerMaxHeightInset: 0,
  },
]

/** 基础（桌面 / 横屏）几何。 */
export const TABLE_BASE: TableBaseGeometry = {
  railWidth: 16,
  stagePadding: { top: 4, right: 16, bottom: 0, left: 16 },
  maxHeight: 460,
}

/** 竖屏舞台留白：上方给 HUD 浮动胶囊让位，下方给本人座位与英雄手牌区留呼吸空间。 */
/*
 * 竖屏舞台留白。
 * 顶部 50px 给 HUD 浮动胶囊；底部 38px 原来留给「本人座位 + 英雄手牌」的呼吸空间，
 * 现在操作区的离座/退出已改到座舱右上角、不再占一行，底部可以再收 10px 给牌桌。
 */
export const STAGE_PADDING_PORTRAIT = { top: 48, right: 8, bottom: 28, left: 8 }
/** 超短屏舞台留白：把纵向空间让给牌桌。 */
export const STAGE_PADDING_COMPACT = { top: 30, right: 6, bottom: 24, left: 6 }
/** 低于这个高度用紧凑舞台留白。 */
export const COMPACT_STAGE_MAX_HEIGHT = 600

/**
 * 生成牌桌几何 CSS（基础变量 + 每个档位的媒体查询覆盖）。
 *
 * 注：媒体查询里的自定义属性**不能**写到 `:root` 上——
 * `:root` 上的声明只会按「元素自身」的视口条件求值一次并全局继承，
 * 媒体查询切换时不会重新解析。必须落到实际使用它的元素上（`.table` / `.stage`），
 * 这里用 `var()` 的继承链把档位值分别挂到这两个选择器上。
 */
export function buildTableGeometryCss(): string {
  const base = `
:root {
  --rail-width: ${String(TABLE_BASE.railWidth)}px;
  --stage-pad-top: ${String(TABLE_BASE.stagePadding.top)}px;
  --stage-pad-right: ${String(TABLE_BASE.stagePadding.right)}px;
  --stage-pad-bottom: ${String(TABLE_BASE.stagePadding.bottom)}px;
  --stage-pad-left: ${String(TABLE_BASE.stagePadding.left)}px;
  --table-max-height: 100%;
}
`
  const tiers = TABLE_GEOMETRY.map((tier) => {
    const padding = tier.name === 'compact' ? STAGE_PADDING_COMPACT : STAGE_PADDING_PORTRAIT
    return `
@media ${tier.query} {
  .stage {
    --stage-pad-top: ${String(padding.top)}px;
    --stage-pad-right: ${String(padding.right)}px;
    --stage-pad-bottom: ${String(padding.bottom)}px;
    --stage-pad-left: ${String(padding.left)}px;
  }
  .table {
    --table-width: ${tier.width};
    --table-height: ${tier.height};
    --table-max-height: ${String(TABLE_BASE.maxHeight)}px;
    --seat-anchor-x: ${String(tier.anchor.x)}%;
    --seat-anchor-y: ${String(tier.anchor.y)}%;
    --seat-w: ${tier.seatWidth};
    --seat-w-side: ${tier.sideSeatWidth};
    --seat-padding-block: ${tier.seatPaddingBlock};
    --center-inset: ${String(tier.centerInset)}px;
    --board-cw: ${tier.boardCardWidth};
    --center-top: ${tier.centerTop};
    --center-max-height-inset: ${String(tier.centerMaxHeightInset)}px;
  }
}
`
  })

  return base + tiers.join('')
}
