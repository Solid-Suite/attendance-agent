/**
 * Vòng chạy của agent.
 *
 * Một nhịp: đọc từ watermark → gửi ERP → chỉ khi ERP xác nhận mới đẩy watermark
 * lên. Thứ tự đó là thứ bảo đảm không mất dữ liệu: hỏng ở bất cứ bước nào thì
 * watermark đứng yên và nhịp sau đọc lại đúng đoạn đó. Gửi trùng vô hại vì ERP
 * chống trùng theo `externalId`.
 */

import type { AgentConfig } from './config';
import { backoffMs, ErpClient, PermanentError, TransientError, type IngestResult } from './erp-client';
import type { PunchSource } from './source-postgres';
import { readState, writeState, type AgentState } from './state';

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[agent] ${m}`),
  warn: (m) => console.warn(`[agent] ${m}`),
  error: (m) => console.error(`[agent] ${m}`),
};

export interface TickResult {
  /** Số lượt quẹt đã gửi trong nhịp này. */
  sent: number;
  /** Nguồn còn dữ liệu chờ hay không — còn thì nên chạy tiếp ngay. */
  hasMore: boolean;
  result?: IngestResult;
}

export interface AgentDeps {
  config: AgentConfig;
  source: PunchSource;
  client: ErpClient;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Agent {
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private state: AgentState;
  private stopped = false;

  constructor(private readonly deps: AgentDeps) {
    this.logger = deps.logger ?? consoleLogger;
    this.sleep = deps.sleep ?? defaultSleep;
    this.state = readState(deps.config.statePath, deps.config.source.initialWatermark);
  }

  getState(): AgentState {
    return { ...this.state };
  }

  /**
   * Một nhịp đọc–gửi–ghi watermark.
   *
   * Ném `PermanentError` ra ngoài: sai key hay sai mã máy thì phải dừng để người
   * ta biết mà sửa, không được nuốt lỗi rồi chạy vô ích.
   */
  async tick(): Promise<TickResult> {
    const { config, source, client } = this.deps;
    const batch = await source.fetchAfter(this.state.watermark, config.batchSize);

    if (batch.punches.length === 0) {
      // Cả lô toàn dòng hỏng: watermark vẫn phải nhích lên, nếu không agent kẹt
      // mãi ở đúng chỗ đó.
      if (batch.watermark !== this.state.watermark) {
        this.advance(batch.watermark, 0);
        return { sent: 0, hasMore: true };
      }
      return { sent: 0, hasMore: false };
    }

    const result = await client.sendPunches(batch.punches, batch.watermark);
    this.advance(batch.watermark, result.accepted);

    if (result.rejected > 0) {
      this.logger.warn(
        `${result.rejected} dòng bị từ chối: ` +
          (result.rejections ?? []).slice(0, 3).map((r) => `${r.externalId} (${r.reason})`).join('; '),
      );
    }
    if (result.unmatched && result.unmatched > 0) {
      this.logger.warn(
        `${result.unmatched} lượt quẹt chưa khớp được nhân viên — cần map mã trên ERP.`,
      );
    }
    this.logger.info(
      `Đã gửi ${batch.punches.length} lượt (mới ${result.accepted}, trùng ${result.duplicated}), ` +
        `dựng ${result.aggregated} ngày công. Watermark: ${batch.watermark}`,
    );

    // Lô đầy nghĩa là nguồn nhiều khả năng còn dữ liệu chờ.
    return { sent: batch.punches.length, hasMore: batch.punches.length >= config.batchSize, result };
  }

  private advance(watermark: string, sent: number) {
    this.state = {
      watermark,
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      totalSent: this.state.totalSent + sent,
    };
    writeState(this.deps.config.statePath, this.state);
  }

  private recordError(message: string) {
    this.state = { ...this.state, lastError: message };
    writeState(this.deps.config.statePath, this.state);
  }

  stop() {
    this.stopped = true;
  }

  /** Chạy liên tục cho tới khi `stop()` hoặc gặp lỗi vĩnh viễn. */
  async run(): Promise<void> {
    const { config } = this.deps;
    let attempt = 0;

    this.logger.info(
      `Bắt đầu: máy ${config.erp.deviceCode} → ${config.erp.baseUrl}, watermark ${this.state.watermark}`,
    );

    while (!this.stopped) {
      try {
        const { hasMore } = await this.tick();
        attempt = 0;
        if (!this.stopped) await this.sleep(hasMore ? 0 : config.intervalSeconds * 1000);
      } catch (err) {
        if (err instanceof PermanentError) {
          this.recordError(err.message);
          this.logger.error(`Lỗi cấu hình/quyền (HTTP ${err.status}): ${err.message}. Agent dừng.`);
          throw err;
        }
        attempt += 1;
        const wait = backoffMs(attempt);
        const message = err instanceof TransientError ? err.message : String((err as any)?.message ?? err);
        this.recordError(message);
        this.logger.warn(`Lỗi tạm (lần ${attempt}): ${message}. Thử lại sau ${Math.round(wait / 1000)}s.`);
        await this.sleep(wait);
      }
    }
  }
}
