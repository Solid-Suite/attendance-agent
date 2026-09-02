/**
 * Watermark bền vững — mốc agent đã đẩy tới đâu ở nguồn.
 *
 * Đây là toàn bộ trạng thái agent cần giữ. Không có hàng đợi cục bộ: ERP chống
 * trùng theo `externalId`, nên gửi lại một lô đã gửi là vô hại. Mất mạng thì
 * watermark đứng yên và lần sau đọc lại đúng từ chỗ đó.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AgentState {
  watermark: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  totalSent: number;
}

export function emptyState(initialWatermark: string): AgentState {
  return { watermark: initialWatermark, lastSuccessAt: null, lastError: null, totalSent: 0 };
}

export function readState(path: string, initialWatermark: string): AgentState {
  if (!existsSync(path)) return emptyState(initialWatermark);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      watermark: String(parsed?.watermark ?? initialWatermark),
      lastSuccessAt: parsed?.lastSuccessAt ?? null,
      lastError: parsed?.lastError ?? null,
      totalSent: Number(parsed?.totalSent ?? 0) || 0,
    };
  } catch {
    // File hỏng (mất điện giữa lúc ghi ở phiên bản cũ): quay về mốc khởi tạo
    // còn hơn là chạy với watermark rác. ERP sẽ bỏ qua phần đã có.
    return emptyState(initialWatermark);
  }
}

/**
 * Ghi nguyên tử: ghi ra file tạm rồi đổi tên. Mất điện giữa chừng thì file cũ
 * còn nguyên, không bao giờ có state cụt.
 */
export function writeState(path: string, state: AgentState): void {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}
