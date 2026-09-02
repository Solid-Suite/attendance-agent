/**
 * Nguồn dữ liệu: PostgreSQL của công ty.
 *
 * Agent chỉ ĐỌC. Câu truy vấn do người cấu hình viết, agent không tự đoán tên
 * bảng — mỗi công ty một cấu trúc khác nhau, đoán là hỏng.
 */

import { Pool } from 'pg';
import type { AgentConfig } from './config';
import type { PunchPayload } from './erp-client';

export interface SourceBatch {
  punches: PunchPayload[];
  /** Watermark mới = giá trị cột watermark của dòng cuối cùng. */
  watermark: string;
}

export interface PunchSource {
  fetchAfter(watermark: string, limit: number): Promise<SourceBatch>;
  close(): Promise<void>;
}

/** Chuẩn hoá thời điểm quẹt về ISO 8601 CÓ offset. */
export function toIsoWithOffset(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number') {
    const d = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    // Chuỗi không có offset thì gửi nguyên trạng: ERP sẽ hiểu theo múi giờ đã
    // khai của máy. Tự gắn "Z" ở đây là cách chắc chắn làm lệch cả lô.
    return value.trim();
  }
  return null;
}

/**
 * Chuyển các dòng SQL thành payload gửi ERP.
 *
 * Dòng thiếu khoá hoặc thiếu thời gian bị bỏ tại chỗ — gửi lên cũng bị ERP từ
 * chối, nhưng ở đây ta còn đếm được và ghi log rõ ràng hơn.
 */
export function mapRows(
  rows: Record<string, unknown>[],
  columns: AgentConfig['source']['columns'],
): { punches: PunchPayload[]; skipped: number } {
  const punches: PunchPayload[] = [];
  let skipped = 0;

  for (const row of rows) {
    const externalId = row[columns.externalId];
    const employeeCode = row[columns.employeeCode];
    const punchedAt = toIsoWithOffset(row[columns.punchedAt]);

    if (externalId === null || externalId === undefined || !employeeCode || !punchedAt) {
      skipped += 1;
      continue;
    }

    const direction = columns.direction ? row[columns.direction] : undefined;
    const method = columns.method ? row[columns.method] : undefined;

    punches.push({
      externalId: String(externalId),
      employeeCode: String(employeeCode),
      punchedAt,
      ...(direction ? { direction: String(direction).toUpperCase() } : {}),
      ...(method ? { method: String(method).toUpperCase() } : {}),
      raw: row,
    });
  }

  return { punches, skipped };
}

export class PostgresSource implements PunchSource {
  private readonly pool: Pool;

  constructor(private readonly cfg: AgentConfig) {
    this.pool = new Pool({
      connectionString: cfg.source.connectionString,
      // Agent chỉ đọc theo chu kỳ, không cần giữ nhiều kết nối của công ty.
      max: 2,
      idleTimeoutMillis: 30_000,
    });
  }

  async fetchAfter(watermark: string, limit: number): Promise<SourceBatch> {
    const res = await this.pool.query(this.cfg.source.query, [watermark, limit]);
    const rows = res.rows as Record<string, unknown>[];
    if (rows.length === 0) return { punches: [], watermark };

    const { punches } = mapRows(rows, this.cfg.source.columns);

    // Watermark lấy từ dòng CUỐI của kết quả, kể cả khi dòng đó bị bỏ qua —
    // nếu không, một dòng hỏng sẽ chặn agent đứng tại chỗ vĩnh viễn.
    const last = rows[rows.length - 1]!;
    const next = last[this.cfg.source.watermarkColumn];
    const nextWatermark = next instanceof Date ? next.toISOString() : String(next ?? watermark);

    return { punches, watermark: nextWatermark };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
