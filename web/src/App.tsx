import { useEffect, useState } from "react";
import type { Trip } from "@goplay/shared";
import InitFlow from "./components/InitFlow";
import ShareView from "./components/ShareView";
import TripView from "./components/TripView";
import { isV11Trip } from "./lib/trip";
import {
  TripLoadCancelledError,
  classifyTripLoadError,
  loadTripWithRetry,
} from "./lib/tripBootstrap";

type Phase =
  | { kind: "loading" }
  /** 临时连不上（服务重启 / 代理 502-504 / 超时）：保留 tripId，给手动重试，绝不落到初始化 */
  | { kind: "unreachable"; message: string }
  | { kind: "init"; notice?: string }
  | { kind: "trip"; tripId: string; trip?: Trip }
  /** Task #205：/share/:tripId 只读分享（不读本地 Trip，不做任何写入） */
  | { kind: "share"; tripId: string };

/** tripId 寻址顺序：URL ?tripId= 优先，其次 localStorage（goplay.tripId） */
function readInitialTripId(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("tripId");
    if (fromUrl) return fromUrl;
  } catch {
    /* 非 http 环境 */
  }
  try {
    return localStorage.getItem("goplay.tripId");
  } catch {
    return null;
  }
}

/**
 * 只读分享路由（Task #205）：/share/:tripId。
 * 手动解析 pathname（不引入 react-router）：只匹配单段 tripId，其余路径照旧走主应用。
 * dev / preview 下的 SPA 回退由 Vite 默认 appType=spa 保证（见 vite.config.ts 注释）。
 */
function readShareTripId(): string | null {
  try {
    const match = /^\/share\/([^/]+)\/?$/.exec(window.location.pathname);
    if (match === null) return null;
    const tripId = decodeURIComponent(match[1]).trim();
    return tripId === "" ? null : tripId;
  } catch {
    return null;
  }
}

/** 清理本地 tripId 线索与行程缓存（指向 404 / 旧 schema 时重新初始化） */
function clearStoredTrip() {
  try {
    localStorage.removeItem("goplay.tripId");
    localStorage.removeItem("goplay.trip");
  } catch {
    /* 忽略 */
  }
}

/**
 * 顶层路由：
 * - loading：本地有 tripId 线索，向服务端校验（含有限自动重试）
 * - unreachable：临时连不上，保留 tripId 并提供手动重试（不展示初始化表单）
 * - init：无 tripId（或明确 404 / 旧 schema），进入 F0 初始化
 * - trip：显示 TripView（携带启动时已取到的行程，避免二次请求）
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>(() => {
    // 分享链接优先：不在接收方浏览器里读 / 写任何本地行程状态
    const shareTripId = readShareTripId();
    if (shareTripId !== null) return { kind: "share", tripId: shareTripId };
    return readInitialTripId() ? { kind: "loading" } : { kind: "init" };
  });
  /** 自动重试过程中的进度提示（仍在 loading 阶段，只换 boot 文案） */
  const [bootHint, setBootHint] = useState<string | null>(null);

  // Task #106 键盘适配：把 .app 高度绑定视觉视口（visualViewport）。手机键盘弹出时
  // vh/dvh 不变（布局视口不变），底部 Sheet 的主行动（如「保存攻略」）会被键盘遮住；
  // 写入 --app-height 后 .app 随键盘缩小，Sheet 上移露出按钮。桌面端视觉视口
  // 尺寸稳定，行为与原来一致。
  useEffect(() => {
    const vv = window.visualViewport;
    if (vv === null || vv === undefined) return;
    /**
     * Task #242 性能：visualViewport 的 scroll 在移动端滚动 / 地址栏收起时按帧触发，
     * 每次 setProperty 都会让根元素样式失效重算（连带整个 .app 子树重排）。高度未变时
     * 直接跳过写入，行为完全等价，但把高频无意义的重排去掉。
     */
    let appliedHeight = -1;
    const apply = () => {
      const height = vv.height;
      if (height === appliedHeight) return;
      appliedHeight = height;
      document.documentElement.style.setProperty("--app-height", `${height}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);

  useEffect(() => {
    if (phase.kind !== "loading") return;
    const tripId = readInitialTripId();
    if (!tripId) {
      setPhase({ kind: "init" });
      return;
    }
    let active = true;
    setBootHint(null);
    void (async () => {
      try {
        const trip = await loadTripWithRetry(tripId, {
          isActive: () => active,
          onRetry: ({ attempt, total }) => {
            if (active) setBootHint(`连接不太稳，正在重试（${attempt}/${total}）…`);
          },
        });
        if (!active) return;
        // v1.1 结构闸门：旧 schema（服务端并行适配中）不做渲染，清理后重新初始化，不崩溃
        if (!isV11Trip(trip)) {
          clearStoredTrip();
          setPhase({
            kind: "init",
            notice: "检测到旧版本行程结构，已重新开始；请重新初始化行程",
          });
          return;
        }
        setPhase({ kind: "trip", tripId, trip });
      } catch (error) {
        if (!active || error instanceof TripLoadCancelledError) return;
        // Task #158：只有 404（行程确实不存在）才清本地引用；临时失败保留 tripId
        const failure = classifyTripLoadError(error);
        if (failure.kind === "not-found") {
          clearStoredTrip();
          setPhase({ kind: "init" });
          return;
        }
        setPhase({ kind: "unreachable", message: failure.message });
      }
    })();
    return () => {
      active = false;
    };
  }, [phase.kind]);

  const handleTripCreated = (trip: Trip) => {
    if (!isV11Trip(trip)) {
      // 服务端尚未适配 v1.1 契约（Task #49 并行中）：不进入旧结构，避免渲染崩溃
      setPhase({
        kind: "init",
        notice: "服务端尚未适配 v1.1 行程结构，创建未生效；请等待服务端更新后重试",
      });
      return;
    }
    try {
      localStorage.setItem("goplay.tripId", trip.tripId);
    } catch {
      /* 忽略 */
    }
    setPhase({ kind: "trip", tripId: trip.tripId, trip });
  };

  /**
   * 新建行程（Task #66）：TripView 已删除旧行程并清掉本地缓存，这里只需回到初始化。
   * URL 上的旧 ?tripId= 会被 readInitialTripId 优先读取，必须先移除，
   * 否则刷新会把用户重新指向已删除的旧行程。
   */
  const handleNewTrip = () => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("tripId")) {
        url.searchParams.delete("tripId");
        window.history.replaceState(null, "", url.toString());
      }
    } catch {
      /* 非 http 环境 */
    }
    setPhase({ kind: "init" });
  };

  /** 手动重试：回到 loading 重新走一遍（tripId 仍在本地，不会被清） */
  const handleRetry = () => {
    setBootHint(null);
    setPhase({ kind: "loading" });
  };

  if (phase.kind === "share") {
    return <ShareView tripId={phase.tripId} />;
  }
  if (phase.kind === "loading") {
    return (
      <div className="boot" aria-live="polite">
        <div className="boot-mark">G</div>
        {bootHint ?? "正在打开行程…"}
      </div>
    );
  }
  if (phase.kind === "unreachable") {
    return (
      <div className="boot boot-error" role="alert">
        <div className="boot-mark">G</div>
        <p className="boot-title">暂时无法连接</p>
        <p className="boot-note">
          {phase.message}；行程没有丢，等服务恢复后点「重试」继续
        </p>
        <button type="button" onClick={handleRetry}>
          重试
        </button>
      </div>
    );
  }
  if (phase.kind === "init") {
    return <InitFlow notice={phase.notice ?? null} onComplete={handleTripCreated} />;
  }
  return <TripView tripId={phase.tripId} initialTrip={phase.trip} onNewTrip={handleNewTrip} />;
}
