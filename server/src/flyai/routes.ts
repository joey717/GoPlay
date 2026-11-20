/**
 * FlyAI 搜索路由（挂载于 /api/flyai）。
 *
 * GET /search?type=poi|hotel…：成功返回 FlyAISearchResult 封套；
 * 失败统一返回安全错误结构 { code, message, retryable }（Task #55）：
 * - 外部额度耗尽 / 普通限流（429）映射为网关类 503，不直接透传外部状态；
 * - message 为简洁中文安全文案，绝不透出原始 body、CLI 命令、控制台地址或 API Key 指引；
 * - 原始 CLI 报错细节只进服务端日志（redactSecretsForLog 脱敏后），不进响应体；
 * - 参数校验错误为 400 + code=FLYAI_INVALID_REQUEST。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { findAreaByName } from "@goplay/shared";
import { searchHotels, searchPoi, type SearchHotelsOptions } from "./client.js";
import { flyAiInvalidRequest, redactSecretsForLog, toSafeFlyAiError } from "./errors.js";

/**
 * 路由依赖注入：默认直连真实 CLI；验证脚本可注入桩函数，
 * 在离线环境下做 /search 的 HTTP 错误契约测试（verify-errors.ts）。
 */
export interface FlyAiRouteDeps {
  searchPoi: typeof searchPoi;
  searchHotels: typeof searchHotels;
}

const DEFAULT_DEPS: FlyAiRouteDeps = { searchPoi, searchHotels };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 失败统一出口：安全结构 + 服务端日志（原始细节脱敏）；绝不透出原始 body / 命令 / 密钥 */
function fail(c: Context, error: unknown): Response {
  const safe = toSafeFlyAiError(error);
  console.error(
    `[FlyAI] 搜索失败（${safe.code}）：${redactSecretsForLog(safe.rawDetail).slice(0, 2000)}`,
  );
  return c.json(safe.toSafeBody(), safe.status as ContentfulStatusCode);
}

/** 参数校验失败的统一出口（400）：同样只返回安全结构 */
function badRequest(c: Context, message: string): Response {
  return c.json(flyAiInvalidRequest(message), 400 as ContentfulStatusCode);
}

export function createFlyAiRoutes(deps: FlyAiRouteDeps = DEFAULT_DEPS): Hono {
  const app = new Hono();

  app.get("/search", async (c) => {
    const type = c.req.query("type");
    const query = c.req.query("q")?.trim();

    if (type !== "poi" && type !== "hotel") {
      return badRequest(c, "type 仅支持 poi 或 hotel");
    }

    try {
      if (type === "poi") {
        if (!query) {
          return badRequest(c, "q 搜索关键词不能为空");
        }
        // destination：结构化目的地（Trip.destination.city），权威过滤在 searchPoi 内部执行
        const destination = c.req.query("destination")?.trim() || null;
        return c.json(await deps.searchPoi(query, { destination }));
      }

      // ===== 酒店搜索（F6，Task #45）：结构化 destination + area（或 q）+ 日期 =====
      // 不再接受「三亚 老城」这类拼接关键词——「老城」会被飞猪后端全球模糊匹配到境外 Old Town。
      const destination = c.req.query("destination")?.trim() || null;
      if (!destination) {
        return badRequest(c, "酒店搜索必须携带结构化 destination（如 三亚）");
      }
      const areaName = c.req.query("area")?.trim() || null;
      if (!areaName && !query) {
        return badRequest(c, "酒店搜索需要 area 片区与 q 关键词二选一");
      }
      const area: SearchHotelsOptions["area"] = areaName ? findAreaByName(areaName) : undefined;
      if (areaName && !area) {
        return badRequest(c, `未知片区「${areaName}」，仅支持已配置的三亚片区`);
      }

      const checkIn = c.req.query("checkIn");
      const checkOut = c.req.query("checkOut");
      if (!checkIn || !checkOut || !ISO_DATE_PATTERN.test(checkIn) || !ISO_DATE_PATTERN.test(checkOut)) {
        return badRequest(c, "酒店搜索需要 YYYY-MM-DD 格式的 checkIn 和 checkOut");
      }
      if (checkOut <= checkIn) {
        return badRequest(c, "checkOut 必须晚于 checkIn");
      }
      // 片区搜索时关键词由服务端配置解析（明确本地语义），不信任调用方拼接词
      return c.json(
        await deps.searchHotels({ destination, area, keyword: area ? null : query }, checkIn, checkOut),
      );
    } catch (error) {
      return fail(c, error);
    }
  });

  return app;
}

export const flyaiRoutes = createFlyAiRoutes();
