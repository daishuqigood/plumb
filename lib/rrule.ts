/**
 * lib/rrule.ts — 自研 RRULE 子集（~60 行，不引第三方依赖）
 *
 * 支持：FREQ=DAILY|WEEKLY|MONTHLY + INTERVAL=n + COUNT=n | UNTIL=<utc-ts>
 * 不支持：BYDAY/BYMONTHDAY/EXDATE 等复杂规则（个人场景不需要）
 *
 * 格式示例：
 *   FREQ=DAILY
 *   FREQ=WEEKLY;INTERVAL=2
 *   FREQ=MONTHLY;INTERVAL=1;COUNT=12
 *   FREQ=WEEKLY;UNTIL=2026-12-31T23:59:59Z
 */

export type RRuleFreq = "DAILY" | "WEEKLY" | "MONTHLY";

export interface RRule {
  freq: RRuleFreq;
  interval: number;      // 默认 1
  count?: number;        // 最多 N 次（不含当前次）
  until?: string;        // UTC ISO8601，上限（含）
}

/** 解析 RRULE 字符串，返回 null 表示格式无效 */
export function parseRRule(s: string): RRule | null {
  if (!s) return null;
  const parts = s.split(";");
  const map: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    map[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }

  const freq = map["FREQ"] as RRuleFreq | undefined;
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) return null;

  const interval = map["INTERVAL"] ? parseInt(map["INTERVAL"], 10) : 1;
  if (isNaN(interval) || interval < 1) return null;

  const rule: RRule = { freq, interval };

  if (map["COUNT"]) {
    const count = parseInt(map["COUNT"], 10);
    if (!isNaN(count) && count > 0) rule.count = count;
  }
  if (map["UNTIL"]) {
    rule.until = map["UNTIL"];
  }

  return rule;
}

/** 序列化 RRule 对象到字符串 */
export function serializeRRule(r: RRule): string {
  let s = `FREQ=${r.freq}`;
  if (r.interval !== 1) s += `;INTERVAL=${r.interval}`;
  if (r.count !== undefined) s += `;COUNT=${r.count}`;
  if (r.until !== undefined) s += `;UNTIL=${r.until}`;
  return s;
}

/**
 * 计算本次完成后的下一个 due_ts（UTC ISO8601 字符串）。
 * @param currentDueTs  当前 due_ts（UTC）
 * @param rruleStr      RRULE 字符串
 * @param completionCount  已完成次数（含本次）；用于 COUNT 判断
 * @returns 下一个 due_ts，或 null（已到达 COUNT/UNTIL 上限，不再重复）
 */
export function nextDueTs(
  currentDueTs: string,
  rruleStr: string,
  completionCount: number,
): string | null {
  const rule = parseRRule(rruleStr);
  if (!rule) return null;

  // COUNT 检查：如果 count 已定义且完成次数已达上限，不再重复
  if (rule.count !== undefined && completionCount >= rule.count) return null;

  const base = new Date(currentDueTs);
  if (isNaN(base.getTime())) return null;

  let next: Date;
  switch (rule.freq) {
    case "DAILY":
      next = new Date(base.getTime());
      next.setUTCDate(next.getUTCDate() + rule.interval);
      break;
    case "WEEKLY":
      next = new Date(base.getTime());
      next.setUTCDate(next.getUTCDate() + rule.interval * 7);
      break;
    case "MONTHLY": {
      next = new Date(base.getTime());
      const m = next.getUTCMonth() + rule.interval;
      next.setUTCFullYear(next.getUTCFullYear() + Math.floor(m / 12));
      next.setUTCMonth(m % 12);
      // 月末日期保护：若日超出新月份天数，截至月末
      const maxDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
      if (next.getUTCDate() > maxDay) next.setUTCDate(maxDay);
      break;
    }
  }

  const nextTs = next.toISOString();

  // UNTIL 检查
  if (rule.until && nextTs > rule.until) return null;

  return nextTs;
}

/** 验证 RRULE 字符串是否有效（用于 CLI 校验） */
export function validateRRule(s: string): string | null {
  const r = parseRRule(s);
  if (!r) return `Invalid RRULE: "${s}". Expected format: FREQ=DAILY|WEEKLY|MONTHLY[;INTERVAL=n][;COUNT=n|;UNTIL=<iso-ts>]`;
  return null;
}
