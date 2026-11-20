/**
 * Task #293：Q7 点位配图真值表（唯一数据源）——修复评测夹具自造页码导致的「假绿」。
 *
 * 背景（#288 诊断）：旧夹具以 `Q7_PAGE_START(3) + 路线序号` 伪造 8 个点位的
 * mention.pageRefs（=3..10）与 quoteText（「西岛拍照路线：X（p3）」等句子在笔记中
 * 根本不存在），机器断言复算的正是同一份自造数据（同义反复 trivially pass），
 * Q7.png 8/8 全部错配。本模块固化笔记真实 PX 标注，`eval/cases/v14Cases.ts buildQ7Trip`
 * 与 `web/src/eval-ui.tsx sceneQ7` 共用，禁止再按序号推算页码。
 *
 * 真值来源（两条独立证据链，runner --only=Q7 每次离线复核）：
 * 1. 抽取缓存 eval/cache/extraction/6ace31c6….json 的笔记正文（🌟路线：逐 ➡️ 行），
 *    经产品解析器 shared extractPageRefs 实跑得 [4,5]/[6]/[2,8,9]/[1,3]/[11,12,13]/[16,17]/[14]/[]；
 * 2. 真实落盘行程 server/data/48275e19….json 的 ev_note_3 mentions 页码与笔记一致。
 *
 * quoteText 一律为笔记原句逐字（含 ➡️ 前缀与全角括号），runQ7 断言其逐字存在于
 * 抽取缓存正文（夹具保真断言）；pageRefs 必须等于 extractPageRefs(quoteText)。
 *
 * 产品口径说明（PD 已裁：忽略，不扩展——Task #293）：shared/src/guides/pageImages.ts 的
 * PAGE_REF_PATTERN 不识别「p14 15」中无 p 前缀的后续页码，孤独的树只绑 p14。
 * PD 裁定口径：PX 标注只用于对应图片，「p14 15」意为两张图任一皆可，现有只认 p14
 * 的行为可接受（前提是不打乱其他点位的绑定顺序——本表逐点位真值断言即该前提的机器锚点）。
 * 故本表孤独的树 pageRefs=[14] 为最终真值，非待裁缺口。
 *
 * 纯数据＋纯函数（零 node/fs 依赖）：web 侧（vite dev 渲染 eval-ui.html?scene=q7）
 * 与 eval 侧（tsx runner）以同一份源码消费，杜绝两处口径漂移。
 */

/** 西岛笔记 id（小红书原链 / server/uploads/xhs_{noteId}/ 抓取产物目录名共用） */
export const Q7_NOTE_ID = "6ace31c6000000001b0202f7";

/** 笔记标题（夹具 GuideSource.title 用，逐字取自抽取缓存） */
export const Q7_NOTE_TITLE = "三亚西岛太美啦🌊超全seawalk攻略看这篇！";

/** 笔记抓取产物图片数（imageProgress 槽位 total；server/uploads/xhs_6ace31c6… 实存 18 张） */
export const Q7_IMAGE_COUNT = 18;

/**
 * Task #297：西岛大景区父卡飞猪主图真值——修 #296 遗留的夹具保真缺口。
 *
 * 背景：#296 交付时 buildQ7Trip / sceneQ7 把西岛父卡造成 `origin:"custom" + mainPic:null`，
 * 与真实落盘 server/data/48275e19….json 不符（真实西岛 Item＝origin=fliggy、providerId=2611、
 * mainPic=下方 alicdn 外链）。#296 的优先级逻辑本身正确，但夹具形态失真导致 PD 复核 Q7.png
 * 时看到父卡走 PX 攻略图而非飞猪图。本常量把父卡主图对齐真实飞猪记录，buildQ7Trip 与
 * eval-ui sceneQ7 共用，runQ7 断言「父卡首图＝飞猪 mainPic」、uiShot 断言渲染现场 img.src＝此值。
 *
 * 取真实外链而非本地副本（截图确定性方案，见 uiShot Q7 分支的 naturalWidth 硬门）：
 * ①PD 需目视核对的是真实飞猪西岛照片，本地无独立飞猪图资产（仓内唯一本地图为 PX 笔记图，
 *   挪用会与子点位 PX 图视觉混淆，反而误导）；②CDN 可达性已核（HTTP 200 / ~90KB / 0.12s）；
 * ③uiShot 截图前硬断言父卡 img naturalWidth>0（外链加载成功），不可达即抛错中止——绝不静默
 *   触发 onError 降级 PX 而产出误导性截图；④runQ7（离线 eval:fast 门）只做字符串/逻辑断言、
 *   从不加载该 URL，故离线红线不受影响。
 */
export const Q7_PARENT_MAINPIC = "https://img.alicdn.com/tfscom/TB1lyRxfZbI8KJjy1zdSuve1VXa";

/** 西岛父卡飞猪 providerId（真实落盘 48275e19 的西岛 Item，非伪造） */
export const Q7_PARENT_PROVIDER_ID = "2611";

/**
 * Task #297：拍照线子点位复刻真实形态——命中飞猪 Item 但飞猪无主图（mainPic=null）。
 * 真实落盘 48275e19 的西岛墙/木门/歪脖子椰子树/临海公路/孤独的树等子点位正是
 * 「matchedPointRef 命中飞猪、mainPic 为空」，端到端覆盖 #296「命中飞猪无图→PX 回退」路径
 * （#296 时夹具子点位是 custom 点，该路径在 Q7 截图里从未被覆盖）。
 * 子点位 providerId 按 index 派生的确定性伪值（仅测试夹具用，不复用真实 POI id 防误当真实数据）。
 */
export function q7StopProviderId(index: number): string {
  return `F297_${index}`;
}

/** Q7 场景的单个拍照线点位（真值行） */
export interface Q7Point {
  /** 点位名（与 fixture westIslandPhotoRoute.order 同序同名） */
  readonly name: string;
  /**
   * 笔记真实 PX 标注经产品 extractPageRefs 解析的页码（保序去重）。
   * 空数组＝笔记未对该点位单独标注页码（真实无图回退占位场景，不得伪造）。
   */
  readonly pageRefs: readonly number[];
  /**
   * 笔记原句（逐字，含 ➡️ 前缀）；null＝笔记中不存在专属于该点位的原句
   * （如小吃街只在珊瑚墙句中被路过式提及，无独立标注行）。
   */
  readonly quoteText: string | null;
}

/**
 * 西岛拍照线 8 点位真值表（顺序＝fixture westIslandPhotoRoute.order，runQ7 断言逐名同序）。
 *
 * | # | 点位 | 笔记标注 | pageRefs | 首图 |
 * |---|------|----------|----------|------|
 * | 1 | 彩色西岛字母 | p4 p5 | [4,5] | 4.jpg |
 * | 2 | 西岛墙 | p6 | [6] | 6.jpg |
 * | 3 | 木门与歪脖子椰子树 | p2 p8 p9 | [2,8,9] | 2.jpg |
 * | 4 | 珊瑚墙前椰林沙滩 | p1 p3 | [1,3] | 1.jpg |
 * | 5 | 小吃街 | （无标注） | [] | 回退占位 |
 * | 6 | 珊瑚墙 | p11 p12 p13 | [11,12,13] | 11.jpg |
 * | 7 | 临海公路 | p16 p17 | [16,17] | 16.jpg |
 * | 8 | 孤独的树 | p14 15 | [14]（「任一皆可」口径，PD 已裁不扩展正则，见文件头） | 14.jpg |
 */
export const Q7_POINTS: readonly Q7Point[] = [
  {
    name: "码头出岛内口后左转的彩色西岛字母",
    pageRefs: [4, 5],
    quoteText: "➡️出码头左转出来就能看到沙滩上彩色西岛的字母（p4 p5）不想排队可以学我的角度错位拍 再把后面人消除就行",
  },
  {
    name: "西岛墙",
    pageRefs: [6],
    quoteText: "➡️沿海边路线走右手边能看到西岛墙（p6）",
  },
  {
    name: "木门与歪脖子椰子树",
    pageRefs: [2, 8, 9],
    quoteText: "➡️往前走左边就能看到木门和歪脖子椰子树（p2 p8 p9）人很多要排队！",
  },
  {
    name: "珊瑚墙前椰林沙滩",
    pageRefs: [1, 3],
    quoteText: "➡️再去珊瑚墙前会经过一个沙滩有很多椰子树这里很出片！而且不排队！（p1 p3）",
  },
  {
    name: "小吃街",
    pageRefs: [],
    quoteText: null,
  },
  {
    name: "珊瑚墙",
    pageRefs: [11, 12, 13],
    quoteText: "➡️穿过小吃街左手边就是珊瑚墙 这里很好看（p11 p12 p13）",
  },
  {
    name: "临海公路",
    pageRefs: [16, 17],
    quoteText: "➡️再往前沿海边走是临海公路随手拍都很美 还特别蓝（p16 p17）",
  },
  {
    name: "孤独的树",
    pageRefs: [14],
    quoteText: "➡️再往前走就会看到孤独的树（p14 15）",
  },
];

/** 真实无标注点位名（回退占位断言锚点——旧夹具用自造第 9 点位「无图点位（回退占位）」，已废） */
export const Q7_NO_IMAGE_POINT_NAME = "小吃街";

/** 点位名 → 真值行（重名即抛错，防表内歧义） */
export function findQ7Point(name: string): Q7Point | undefined {
  return Q7_POINTS.find((point) => point.name === name);
}

/**
 * 页码 → 受控图片路径（与夹具 imageProgress.images[i].assetPath 同构：
 * `uploads/xhs_{noteId}/{index}.jpg`）。断言 firstAssetPath/assetPaths 的期望值
 * 由本函数从真值 pageRefs 派生——期望值与夹具槽位同源，杜绝再次「自造数据复算自造数据」。
 */
export function q7AssetPath(page: number): string {
  return `uploads/xhs_${Q7_NOTE_ID}/${page}.jpg`;
}

/** 点位的期望 assetPaths（按 pageRefs 顺序；无标注点位＝空数组＝回退占位） */
export function q7ExpectedAssetPaths(point: Q7Point): string[] {
  return point.pageRefs.map((page) => q7AssetPath(page));
}
