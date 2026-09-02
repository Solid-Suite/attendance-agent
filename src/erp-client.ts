/**
 * Gọi cổng nhận dữ liệu của ERP.
 *
 * Chỉ gọi RA, không mở cổng nào vào mạng công ty.
 */

import { createHash } from 'node:crypto';

export interface PunchPayload {
  externalId: string;
  employeeCode: string;
  punchedAt: string;
  direction?: string;
  method?: string;
  raw?: unknown;
}

export interface IngestResult {
  syncRunId: string;
  received: number;
  accepted: number;
  duplicated: number;
  rejected: number;
  aggregated: number;
  unmatched?: number;
  status: string;
  replayed?: boolean;
  rejections?: { externalId: string; reason: string }[];
}

/** Lỗi không đáng thử lại: payload/quyền sai, thử lại bao nhiêu lần cũng vậy. */
export class PermanentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Lỗi tạm: mạng, 5xx, 429. Thử lại được. */
export class TransientError extends Error {}

/**
 * Khoá idempotency của một lô, suy ra từ chính nội dung lô.
 *
 * Cùng dữ liệu thì cùng khoá, nên lần gửi lại sau khi timeout sẽ được ERP nhận
 * ra là lô cũ thay vì ghi thêm lần nữa.
 */
export function batchKey(deviceCode: string, punches: PunchPayload[]): string {
  const digest = createHash('sha256');
  digest.update(deviceCode);
  for (const p of punches) digest.update('|' + p.externalId);
  return deviceCode + '-' + digest.digest('hex').slice(0, 32);
}

/** Chờ bao lâu trước lần thử thứ `attempt` (bắt đầu từ 1). */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  // Nhiễu ngẫu nhiên để nhiều agent không cùng đập vào ERP một lúc sau sự cố.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

export interface ErpClientOptions {
  baseUrl: string;
  apiKey: string;
  deviceCode: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class ErpClient {
  constructor(private readonly opts: ErpClientOptions) {}

  async sendPunches(punches: PunchPayload[], watermark?: string): Promise<IngestResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);

    let res: Response;
    try {
      res = await doFetch(this.opts.baseUrl + '/api/hrm/attendance/punches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'Idempotency-Key': batchKey(this.opts.deviceCode, punches),
        },
        body: JSON.stringify({
          deviceCode: this.opts.deviceCode,
          punches,
          ...(watermark ? { watermark } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err: any) {
      throw new TransientError('Không gọi được ERP: ' + (err?.message ?? err));
    } finally {
      clearTimeout(timer);
    }

    const body: any = await res.json().catch(() => ({}));

    if (res.ok) return body as IngestResult;

    const message = body?.message || 'HTTP ' + res.status;
    // 429 và 5xx là tạm; 4xx còn lại là sai cấu hình/quyền — dừng lại và báo
    // người quản trị thay vì đập vào ERP mãi.
    if (res.status === 429 || res.status >= 500) throw new TransientError(message);
    throw new PermanentError(message, res.status);
  }
}
