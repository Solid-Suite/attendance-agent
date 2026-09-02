/**
 * Cấu hình agent — đọc từ file JSON, cho phép env ghi đè.
 *
 * Bí mật (API key, chuỗi kết nối DB) nên đặt bằng biến môi trường chứ không
 * viết vào file cấu hình đem đi copy.
 */

import { readFileSync } from 'node:fs';

export interface SourceColumns {
  /** Cột làm khoá duy nhất của bản ghi ở nguồn. */
  externalId: string;
  /** Cột chứa mã nhân viên như máy chấm công lưu. */
  employeeCode: string;
  /** Cột chứa thời điểm quẹt. */
  punchedAt: string;
  direction?: string;
  method?: string;
}

export interface AgentConfig {
  erp: {
    /** Ví dụ: https://erp.123website.com.vn */
    baseUrl: string;
    apiKey: string;
    /** Mã máy đã khai trong ERP. */
    deviceCode: string;
    /** Thời gian chờ mỗi lần gọi (ms). */
    timeoutMs: number;
  };
  source: {
    type: 'postgres';
    connectionString: string;
    /**
     * Câu truy vấn lấy các bản ghi SAU mốc watermark.
     * `$1` = watermark hiện tại, `$2` = số dòng tối đa.
     * Bắt buộc `ORDER BY` theo đúng cột watermark, tăng dần.
     */
    query: string;
    columns: SourceColumns;
    /** Cột dùng làm watermark (giá trị của dòng cuối cùng trong lô). */
    watermarkColumn: string;
    /** Watermark khởi tạo khi chạy lần đầu. */
    initialWatermark: string;
  };
  /** Số dòng mỗi lô. ERP nhận tối đa 1000. */
  batchSize: number;
  /** Chu kỳ quét khi đã hết dữ liệu mới (giây). */
  intervalSeconds: number;
  /** File lưu watermark. Phải nằm trên ổ đĩa bền, không phải /tmp. */
  statePath: string;
}

const DEFAULTS = {
  timeoutMs: 30_000,
  batchSize: 500,
  intervalSeconds: 60,
  statePath: './state.json',
};

/** Trần cứng của ERP — gửi hơn sẽ bị từ chối cả lô. */
export const MAX_BATCH_SIZE = 1000;

export class ConfigError extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`Thiếu cấu hình bắt buộc: ${field}`);
  }
  return value.trim();
}

/**
 * Dựng cấu hình từ object thô + biến môi trường.
 *
 * Tách khỏi việc đọc file để test được, và để nơi gọi tự quyết định nguồn.
 */
export function buildConfig(raw: any, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const erp = raw?.erp ?? {};
  const source = raw?.source ?? {};

  const baseUrl = requireString(env.ERP_BASE_URL ?? erp.baseUrl, 'erp.baseUrl');
  const apiKey = requireString(env.ERP_API_KEY ?? erp.apiKey, 'erp.apiKey');
  const deviceCode = requireString(env.ERP_DEVICE_CODE ?? erp.deviceCode, 'erp.deviceCode');

  const connectionString = requireString(
    env.SOURCE_DATABASE_URL ?? source.connectionString,
    'source.connectionString',
  );
  const query = requireString(source.query, 'source.query');
  const watermarkColumn = requireString(source.watermarkColumn, 'source.watermarkColumn');

  const columns = source.columns ?? {};
  const mapped: SourceColumns = {
    externalId: requireString(columns.externalId, 'source.columns.externalId'),
    employeeCode: requireString(columns.employeeCode, 'source.columns.employeeCode'),
    punchedAt: requireString(columns.punchedAt, 'source.columns.punchedAt'),
    ...(columns.direction ? { direction: String(columns.direction) } : {}),
    ...(columns.method ? { method: String(columns.method) } : {}),
  };

  // Truy vấn phải có ORDER BY, nếu không thứ tự trả về là tuỳ hứng của
  // PostgreSQL và watermark sẽ nhảy cóc — bỏ sót dữ liệu vĩnh viễn.
  if (!/order\s+by/i.test(query)) {
    throw new ConfigError('source.query phải có ORDER BY theo cột watermark, tăng dần');
  }

  const batchSize = Math.min(
    Math.max(1, Number(env.BATCH_SIZE ?? raw?.batchSize ?? DEFAULTS.batchSize) || DEFAULTS.batchSize),
    MAX_BATCH_SIZE,
  );

  return {
    erp: {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey,
      deviceCode,
      timeoutMs: Number(erp.timeoutMs ?? DEFAULTS.timeoutMs) || DEFAULTS.timeoutMs,
    },
    source: {
      type: 'postgres',
      connectionString,
      query,
      columns: mapped,
      watermarkColumn,
      initialWatermark: String(source.initialWatermark ?? '0'),
    },
    batchSize,
    intervalSeconds:
      Math.max(5, Number(env.INTERVAL_SECONDS ?? raw?.intervalSeconds ?? DEFAULTS.intervalSeconds) || DEFAULTS.intervalSeconds),
    statePath: String(env.STATE_PATH ?? raw?.statePath ?? DEFAULTS.statePath),
  };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): AgentConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err: any) {
    throw new ConfigError(`Không đọc được file cấu hình "${path}": ${err.message}`);
  }
  return buildConfig(raw, env);
}
