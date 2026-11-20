/**
 * 统一环境变量初始化模块：显式加载仓库根目录 .env，不依赖进程当前工作目录。
 *
 * 背景：服务端有三种启动方式——根目录 `npm run dev`（concurrently）、
 * `npm run dev -w server`（npm workspaces 将 CWD 切到 server/）、在 server/
 * 目录直接 `tsx watch src/index.ts`。原 `import "dotenv/config"` 按当前工作
 * 目录查找 `.env`，后两种方式会漏掉仓库根目录配置，导致百炼四项变量未加载、
 * F5 抽取与 F11 意图编排全部失败。
 *
 * 定位策略：从本文件位置（import.meta.url，dev 为 server/src、build 后为
 * server/dist）向上查找含 workspaces 字段的 package.json，即仓库根目录，
 * 再加载根目录 `.env`。三种启动方式定位结果一致。
 *
 * 安全约束：任何日志与对外信息只报告变量是否配置，绝不打印、返回或写入密钥值。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** 百炼四要素变量名（变量名非敏感，仅用于缺失提示与状态报告） */
export const BAILIAN_ENV_KEYS = [
  "DASHSCOPE_API_KEY",
  "BAILIAN_APP_ID",
  "BAILIAN_WORKSPACE_ID",
  "BAILIAN_ENVIRONMENT_ID",
] as const;

/**
 * FlyAI 变量名（变量名非敏感，仅用于缺失提示与状态报告）。
 * 正式 FLYAI_API_KEY 必须存在：缺失时搜索链路拒绝调用 CLI，避免静默回落共享试用通道。
 */
export const FLYAI_ENV_KEYS = ["FLYAI_API_KEY"] as const;

/** 向上查找含 workspaces 字段的 package.json，定位 monorepo 根目录 */
function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 10; depth++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          workspaces?: unknown;
        };
        if (pkg.workspaces !== undefined) return dir;
      } catch {
        // package.json 解析失败视为非根目录，继续向上
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // 已到文件系统根
    dir = parent;
  }
  return null;
}

/** 判断单个环境变量是否已配置（只看存在性，不读取内容） */
function isConfigured(key: string): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.trim() !== "";
}

function loadRootEnv(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const root = findWorkspaceRoot(moduleDir);
  if (root === null) {
    console.warn(
      "[env] 未定位到仓库根目录，跳过 .env 加载（环境变量需由外部注入）",
    );
    return;
  }

  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    console.warn(
      `[env] 未找到仓库根目录 .env，百炼与 FlyAI 功能不可用（可参考 .env.example 创建后重启）`,
    );
    return;
  }

  // 已存在的进程环境变量优先，.env 仅补缺（dotenv 默认不覆盖）
  const result = dotenv.config({ path: envPath, quiet: true });
  if (result.error !== undefined) {
    console.warn(
      `[env] 仓库根目录 .env 解析失败：${result.error.message}（环境变量需由外部注入）`,
    );
    return;
  }

  const bailianConfigured = BAILIAN_ENV_KEYS.filter(isConfigured).length;
  const flyaiConfigured = FLYAI_ENV_KEYS.filter(isConfigured).length;
  console.log(
    `[env] 已加载仓库根目录 .env，百炼变量 ${bailianConfigured}/${BAILIAN_ENV_KEYS.length} 项已配置，FlyAI 变量 ${flyaiConfigured}/${FLYAI_ENV_KEYS.length} 项已配置`,
  );
}

/** 缺失的百炼变量名列表（仅变量名，不含值）；空数组表示四项全部就绪 */
export function getMissingBailianVars(): string[] {
  return BAILIAN_ENV_KEYS.filter((key) => !isConfigured(key));
}

/** 缺失的 FlyAI 变量名列表（仅变量名，不含值）；空数组表示已就绪 */
export function getMissingFlyaiVars(): string[] {
  return FLYAI_ENV_KEYS.filter((key) => !isConfigured(key));
}

// 模块加载即完成初始化；ESM 模块缓存保证整个进程只执行一次
loadRootEnv();
