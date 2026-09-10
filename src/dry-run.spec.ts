import { runDryRun, diagnose } from './dry-run';
import type { AgentConfig } from './config';
import type { Logger } from './agent';
import type { PunchSource, SourceBatch } from './source-postgres';

function makeConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    erp: { baseUrl: 'https://erp.example.vn', apiKey: 'att_x', deviceCode: 'MCC01', timeoutMs: 30000 },
    source: {
      type: 'postgres',
      connectionString: 'postgres://u:p@h:5432/d',
      query: 'SELECT id FROM t WHERE id > $1 ORDER BY id ASC LIMIT $2',
      columns: { externalId: 'id', employeeCode: 'employee_code', punchedAt: 'punched_at' },
      watermarkColumn: 'id',
      initialWatermark: '0',
    },
    batchSize: 500,
    intervalSeconds: 60,
    statePath: '/var/lib/x/state.json',
    ...over,
  } as AgentConfig;
}

function makeLogger() {
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);
  return { logger: { info: push, warn: push, error: push } as Logger, lines };
}

function makeSource(batch: Partial<SourceBatch>): PunchSource & { calls: any[]; closed: boolean } {
  const src: any = {
    calls: [],
    closed: false,
    async fetchAfter(watermark: string, limit: number) {
      src.calls.push({ watermark, limit });
      return { punches: [], watermark, skipped: 0, rowsRead: 0, ...batch };
    },
    async close() {
      src.closed = true;
    },
  };
  return src;
}

const punch = (id: string) => ({
  externalId: id,
  employeeCode: 'NV001',
  punchedAt: '2026-09-10T08:05:12+07:00',
  direction: 'IN',
  raw: { id, ghi_chu: 'cả dòng database gốc rất dài' },
});

describe('runDryRun — tuyệt đối không gây tác dụng phụ', () => {
  it('không hề gọi ERP: hàm chỉ nhận source, không nhận client', async () => {
    // Đây là bảo đảm ở mức chữ ký hàm — không có đường nào để gọi ERP.
    expect(runDryRun.length).toBeLessThanOrEqual(4);
  });

  it('chỉ đọc đúng một lô rồi dừng, không lặp', async () => {
    const src = makeSource({ punches: [punch('1')], watermark: '1', rowsRead: 1 });
    const { logger } = makeLogger();
    await runDryRun(makeConfig(), src, logger);
    expect(src.calls).toHaveLength(1);
  });

  it('đọc từ watermark khởi đầu trong config', async () => {
    const src = makeSource({});
    const { logger } = makeLogger();
    await runDryRun(makeConfig({ source: { ...makeConfig().source, initialWatermark: '9900' } } as any), src, logger);
    expect(src.calls[0].watermark).toBe('9900');
  });

  it('nhận watermark truyền vào thì ưu tiên cái đó', async () => {
    const src = makeSource({});
    const { logger } = makeLogger();
    await runDryRun(makeConfig(), src, logger, '4242');
    expect(src.calls[0].watermark).toBe('4242');
  });

  it('dùng đúng batchSize của config', async () => {
    const src = makeSource({});
    const { logger } = makeLogger();
    await runDryRun(makeConfig({ batchSize: 77 }), src, logger);
    expect(src.calls[0].limit).toBe(77);
  });
});

describe('runDryRun — báo cáo trung thực', () => {
  it('đếm đúng đọc được, dùng được, bỏ qua', async () => {
    const src = makeSource({ punches: [punch('1'), punch('2')], watermark: '9', skipped: 3, rowsRead: 5 });
    const { logger } = makeLogger();
    const r = await runDryRun(makeConfig(), src, logger);
    expect(r).toMatchObject({ rowsRead: 5, usable: 2, skipped: 3, watermarkFrom: '0', watermarkTo: '9' });
  });

  it('mẫu in ra tối đa 5 dòng dù lô lớn', async () => {
    const punches = Array.from({ length: 40 }, (_, i) => punch(String(i)));
    const src = makeSource({ punches, watermark: '40', rowsRead: 40 });
    const { logger } = makeLogger();
    const r = await runDryRun(makeConfig(), src, logger);
    expect(r.sample).toHaveLength(5);
  });

  it('KHÔNG in trường raw ra màn hình — nó là cả dòng database gốc', async () => {
    const src = makeSource({ punches: [punch('1')], watermark: '1', rowsRead: 1 });
    const { logger, lines } = makeLogger();
    await runDryRun(makeConfig(), src, logger);
    const all = lines.join('\n');
    expect(all).toContain('NV001');
    expect(all).not.toContain('cả dòng database gốc rất dài');
  });

  it('nói rõ watermark KHÔNG được ghi', async () => {
    const src = makeSource({ punches: [punch('1')], watermark: '1', rowsRead: 1 });
    const { logger, lines } = makeLogger();
    await runDryRun(makeConfig(), src, logger);
    expect(lines.join('\n')).toMatch(/KHÔNG ghi/);
  });
});

describe('runDryRun — chẩn đoán khi không có dữ liệu', () => {
  it('đọc được 0 dòng thì chỉ ra ba nguyên nhân cần kiểm', async () => {
    const src = makeSource({ rowsRead: 0 });
    const { logger, lines } = makeLogger();
    await runDryRun(makeConfig(), src, logger);
    const all = lines.join('\n');
    expect(all).toMatch(/Watermark khởi đầu/);
    expect(all).toMatch(/tên bảng và cột/);
    expect(all).toMatch(/SELECT/);
  });

  it('bỏ qua nhiều thì gợi ý khai sai tên cột', async () => {
    const src = makeSource({ punches: [], watermark: '5', skipped: 5, rowsRead: 5 });
    const { logger, lines } = makeLogger();
    await runDryRun(makeConfig(), src, logger);
    expect(lines.join('\n')).toMatch(/khai sai tên cột/);
  });

  it('có dữ liệu thì nhắc kiểm offset múi giờ', async () => {
    const src = makeSource({ punches: [punch('1')], watermark: '1', rowsRead: 1 });
    const { logger, lines } = makeLogger();
    await runDryRun(makeConfig(), src, logger);
    expect(lines.join('\n')).toMatch(/\+07:00/);
  });
});

describe('diagnose — dịch lỗi database sang câu sửa được', () => {
  it.each([
    ['ECONNREFUSED', /từ chối kết nối/],
    ['ENOTFOUND', /phân giải được tên máy chủ/],
    ['ETIMEDOUT', /tường lửa/],
    ['28P01', /sai tài khoản hoặc mật khẩu/],
    ['3D000', /không có database/],
    ['42P01', /không có bảng/],
    ['42703', /không có cột/],
    ['42501', /quyền SELECT/],
  ])('mã %s được dịch', (code, expected) => {
    expect(diagnose({ code })).toMatch(expected);
  });

  it('nhận ra sai mật khẩu qua nội dung dù không có mã', () => {
    expect(diagnose({ message: 'password authentication failed for user "x"' })).toMatch(
      /sai tài khoản hoặc mật khẩu/,
    );
  });

  it('lỗi lạ thì trả nguyên văn chứ không nuốt mất', () => {
    expect(diagnose(new Error('chuyện gì đó rất lạ'))).toBe('chuyện gì đó rất lạ');
  });

  it('không vỡ với null', () => {
    expect(typeof diagnose(null)).toBe('string');
  });

  it('lỗi đọc database vẫn ném ra ngoài để agent thoát mã khác 0', async () => {
    const boom: any = {
      async fetchAfter() { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); },
      async close() {},
    };
    const lines: string[] = [];
    const log = { info: (s: string) => lines.push(s), warn: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
    await expect(runDryRun(makeConfig(), boom, log as any)).rejects.toBeDefined();
    expect(lines.join('\n')).toMatch(/từ chối kết nối/);
  });
});
