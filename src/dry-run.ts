/**
 * Chế độ chạy thử: đọc thật từ database chấm công của công ty, in ra đúng thứ
 * sẽ gửi, rồi DỪNG.
 *
 * Có ba thứ chế độ này tuyệt đối không làm:
 *   1. Không gọi ERP. Người đi cài thử được phần đọc database trước khi xin token.
 *   2. Không ghi state.json. Chạy thử mười lần vẫn đọc lại đúng đoạn đó.
 *   3. Không nhích watermark.
 *
 * Nhờ vậy chạy thử trên máy khách hàng là an toàn tuyệt đối: không đổi gì, cả
 * bên khách lẫn bên ERP.
 */

import type { AgentConfig } from './config';
import type { Logger } from './agent';
import type { PunchSource } from './source-postgres';

export interface DryRunResult {
  rowsRead: number;
  usable: number;
  skipped: number;
  watermarkFrom: string;
  watermarkTo: string;
  sample: unknown[];
}

/** Số dòng in ra làm mẫu. Đủ để soi mắt thường, không đủ để ngập màn hình. */
const SAMPLE_SIZE = 5;

export async function runDryRun(
  config: AgentConfig,
  source: PunchSource,
  logger: Logger,
  watermark?: string,
): Promise<DryRunResult> {
  const from = watermark ?? config.source.initialWatermark;

  logger.info('── CHẠY THỬ ── không gọi ERP, không ghi watermark, không đổi gì cả');
  logger.info(`Nguồn    : PostgreSQL của công ty`);
  logger.info(`Watermark: bắt đầu từ ${from}`);
  logger.info(`Lô        : tối đa ${config.batchSize} dòng`);

  let batch;
  try {
    batch = await source.fetchAfter(from, config.batchSize);
  } catch (err) {
    logger.error('');
    logger.error(`Không đọc được database: ${diagnose(err)}`);
    throw err;
  }

  const result: DryRunResult = {
    rowsRead: batch.rowsRead,
    usable: batch.punches.length,
    skipped: batch.skipped,
    watermarkFrom: from,
    watermarkTo: batch.watermark,
    sample: batch.punches.slice(0, SAMPLE_SIZE),
  };

  logger.info('');
  logger.info(`Đọc được : ${result.rowsRead} dòng`);
  logger.info(`Dùng được: ${result.usable} dòng`);
  logger.info(`Bỏ qua   : ${result.skipped} dòng`);
  logger.info(`Watermark sẽ nhích tới: ${result.watermarkTo} (chạy thử nên KHÔNG ghi)`);

  if (result.rowsRead === 0) {
    logger.warn('');
    logger.warn('Không đọc được dòng nào. Kiểm ba thứ theo thứ tự:');
    logger.warn(`  1. Watermark khởi đầu (${from}) có quá lớn không — dữ liệu cũ hơn sẽ không được đọc.`);
    logger.warn('  2. Câu truy vấn có đúng tên bảng và cột không.');
    logger.warn('  3. Tài khoản database có quyền SELECT trên bảng đó không.');
    return result;
  }

  if (result.skipped > 0) {
    logger.warn('');
    logger.warn(
      `${result.skipped} dòng bị bỏ vì thiếu mã nhân viên hoặc thiếu thời điểm quẹt. ` +
        'Nếu con số này lớn thì gần như chắc chắn khai sai tên cột trong mục "columns" của config.',
    );
  }

  if (result.usable > 0) {
    logger.info('');
    logger.info(`Mẫu ${Math.min(SAMPLE_SIZE, result.usable)} dòng sẽ gửi lên ERP:`);
    for (const punch of result.sample) {
      // Bỏ trường raw khi in: nó là cả dòng database gốc, in ra thì ngập màn hình.
      const { raw, ...shown } = punch as Record<string, unknown>;
      logger.info(`  ${JSON.stringify(shown)}`);
    }
    logger.info('');
    logger.info('Soát kỹ ba thứ trong mẫu trên trước khi chạy thật:');
    logger.info('  · Mã nhân viên có đúng dạng dùng trong ERP không.');
    logger.info('  · Thời điểm quẹt có kèm offset +07:00 không. Thiếu offset thì ERP hiểu theo múi giờ đã khai cho máy — khai sai là lệch ngày công.');
    logger.info('  · Chiều vào/ra có đúng không.');
  }

  return result;
}

/**
 * Dịch lỗi thô của driver PostgreSQL sang câu người đi cài hiểu và sửa được.
 * Người cài agent ở máy khách hàng thường không phải lập trình viên.
 */
export function diagnose(err: unknown): string {
  const e = err as any;
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? err ?? '');

  if (code === 'ECONNREFUSED')
    return 'máy chủ database từ chối kết nối. Kiểm địa chỉ và cổng trong connectionString, và xem PostgreSQL có đang chạy không.';
  if (code === 'ENOTFOUND')
    return 'không phân giải được tên máy chủ trong connectionString. Kiểm lại tên miền hoặc dùng địa chỉ IP.';
  if (code === 'ETIMEDOUT')
    return 'kết nối quá hạn. Thường là tường lửa chặn, hoặc máy này không nằm trong mạng thấy được database.';
  if (code === '28P01' || /password authentication failed/i.test(msg))
    return 'sai tài khoản hoặc mật khẩu database.';
  if (code === '3D000') return 'không có database với tên đã khai trong connectionString.';
  if (code === '42P01')
    return 'không có bảng như trong câu truy vấn. Kiểm lại tên bảng, và cả schema nếu bảng không nằm trong public.';
  if (code === '42703')
    return 'không có cột như trong câu truy vấn. Kiểm lại tên cột trong query và trong mục columns.';
  if (code === '42501')
    return 'tài khoản database không có quyền SELECT trên bảng này.';
  return msg;
}
