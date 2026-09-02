import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type Logger } from './agent';
import { buildConfig, ConfigError } from './config';
import { backoffMs, batchKey, PermanentError, TransientError, type PunchPayload } from './erp-client';
import { mapRows, toIsoWithOffset } from './source-postgres';
import { readState, writeState } from './state';

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const RAW_CONFIG = {
  erp: { baseUrl: 'https://erp.example.com/', apiKey: 'k', deviceCode: 'MCC01' },
  source: {
    type: 'postgres',
    connectionString: 'postgres://x',
    query: 'SELECT * FROM logs WHERE id > $1 ORDER BY id ASC LIMIT $2',
    columns: { externalId: 'id', employeeCode: 'code', punchedAt: 'at' },
    watermarkColumn: 'id',
    initialWatermark: '0',
  },
};

function tempConfig(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-'));
  return buildConfig({ ...RAW_CONFIG, statePath: join(dir, 'state.json'), ...overrides }, {});
}

describe('buildConfig', () => {
  it('bỏ dấu / thừa ở cuối baseUrl', () => {
    expect(tempConfig().erp.baseUrl).toBe('https://erp.example.com');
  });

  it('biến môi trường ghi đè file cấu hình', () => {
    const cfg = buildConfig(RAW_CONFIG, { ERP_API_KEY: 'từ-env' } as any);
    expect(cfg.erp.apiKey).toBe('từ-env');
  });

  it('báo lỗi rõ ràng khi thiếu trường bắt buộc', () => {
    expect(() => buildConfig({ ...RAW_CONFIG, erp: {} }, {})).toThrow(ConfigError);
  });

  /** Không ORDER BY thì thứ tự tuỳ hứng, watermark nhảy cóc và mất dữ liệu. */
  it('bắt buộc truy vấn phải có ORDER BY', () => {
    const raw = { ...RAW_CONFIG, source: { ...RAW_CONFIG.source, query: 'SELECT * FROM logs' } };
    expect(() => buildConfig(raw, {})).toThrow(/ORDER BY/);
  });

  it('kẹp batchSize trong trần 1000 của ERP', () => {
    expect(buildConfig({ ...RAW_CONFIG, batchSize: 99999 }, {}).batchSize).toBe(1000);
  });
});

describe('mapRows', () => {
  const columns = { externalId: 'id', employeeCode: 'code', punchedAt: 'at', direction: 'dir' };

  it('chuyển dòng SQL thành payload, giữ nguyên dữ liệu gốc', () => {
    const { punches, skipped } = mapRows(
      [{ id: 7, code: 'NV001', at: new Date('2026-09-02T01:05:00Z'), dir: 'in' }],
      columns,
    );
    expect(skipped).toBe(0);
    expect(punches[0]).toMatchObject({
      externalId: '7',
      employeeCode: 'NV001',
      punchedAt: '2026-09-02T01:05:00.000Z',
      direction: 'IN',
    });
  });

  it('bỏ dòng thiếu khoá hoặc thiếu thời gian', () => {
    const { punches, skipped } = mapRows(
      [
        { id: null, code: 'NV001', at: '2026-09-02 08:00:00' },
        { id: 8, code: '', at: '2026-09-02 08:00:00' },
        { id: 9, code: 'NV001', at: null },
      ],
      columns,
    );
    expect(punches).toHaveLength(0);
    expect(skipped).toBe(3);
  });

  /** Tự gắn "Z" vào chuỗi không offset là cách chắc chắn làm lệch cả lô 7 tiếng. */
  it('không tự thêm offset cho chuỗi giờ địa phương', () => {
    expect(toIsoWithOffset('2026-09-02 08:00:00')).toBe('2026-09-02 08:00:00');
  });
});

describe('batchKey', () => {
  it('cùng lô cho cùng khoá', () => {
    const punches: PunchPayload[] = [
      { externalId: '1', employeeCode: 'A', punchedAt: 'x' },
      { externalId: '2', employeeCode: 'B', punchedAt: 'y' },
    ];
    expect(batchKey('MCC01', punches)).toBe(batchKey('MCC01', [...punches]));
  });

  it('lô khác cho khoá khác', () => {
    const a = batchKey('MCC01', [{ externalId: '1', employeeCode: 'A', punchedAt: 'x' }]);
    const b = batchKey('MCC01', [{ externalId: '2', employeeCode: 'A', punchedAt: 'x' }]);
    expect(a).not.toBe(b);
  });

  it('máy khác cho khoá khác', () => {
    const p = [{ externalId: '1', employeeCode: 'A', punchedAt: 'x' }];
    expect(batchKey('MCC01', p)).not.toBe(batchKey('MCC02', p));
  });
});

describe('backoffMs', () => {
  it('tăng dần và có trần', () => {
    expect(backoffMs(1)).toBeLessThanOrEqual(1000);
    expect(backoffMs(3)).toBeLessThanOrEqual(4000);
    expect(backoffMs(50)).toBeLessThanOrEqual(60_000);
  });
});

describe('state', () => {
  it('ghi rồi đọc lại nguyên vẹn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-'));
    const path = join(dir, 'nested', 'state.json');
    writeState(path, { watermark: '42', lastSuccessAt: null, lastError: null, totalSent: 7 });
    expect(readState(path, '0').watermark).toBe('42');
    expect(JSON.parse(readFileSync(path, 'utf8')).totalSent).toBe(7);
  });

  it('file hỏng thì quay về mốc khởi tạo thay vì ném lỗi', () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-'));
    const path = join(dir, 'state.json');
    writeFileSync(path, '{ hỏng');
    expect(readState(path, '100').watermark).toBe('100');
  });

  it('chưa có file thì dùng mốc khởi tạo', () => {
    expect(readState(join(tmpdir(), 'không-tồn-tại-' + Date.now()), '5').watermark).toBe('5');
  });
});

describe('Agent.tick', () => {
  const punch = (id: string) => ({ externalId: id, employeeCode: 'NV001', punchedAt: '2026-09-02T08:00:00+07:00' });

  const okResult = (accepted: number) => ({
    syncRunId: 'r1', received: accepted, accepted, duplicated: 0,
    rejected: 0, aggregated: 1, status: 'SUCCESS',
  });

  it('gửi xong mới đẩy watermark', async () => {
    const config = tempConfig();
    const source = {
      fetchAfter: jest.fn().mockResolvedValue({ punches: [punch('1')], watermark: '10' }),
      close: jest.fn(),
    };
    const client = { sendPunches: jest.fn().mockResolvedValue(okResult(1)) } as any;

    const agent = new Agent({ config, source, client, logger: silent });
    const res = await agent.tick();

    expect(res.sent).toBe(1);
    expect(agent.getState().watermark).toBe('10');
    expect(client.sendPunches).toHaveBeenCalledWith([punch('1')], '10');
  });

  /** Điểm sống còn: ERP lỗi thì watermark KHÔNG được nhích, nếu không mất dữ liệu. */
  it('ERP lỗi thì watermark đứng yên', async () => {
    const config = tempConfig();
    const source = {
      fetchAfter: jest.fn().mockResolvedValue({ punches: [punch('1')], watermark: '10' }),
      close: jest.fn(),
    };
    const client = { sendPunches: jest.fn().mockRejectedValue(new TransientError('mạng đứt')) } as any;

    const agent = new Agent({ config, source, client, logger: silent });
    await expect(agent.tick()).rejects.toBeInstanceOf(TransientError);
    expect(agent.getState().watermark).toBe('0');
  });

  it('không có dữ liệu mới thì không gọi ERP', async () => {
    const config = tempConfig();
    const source = { fetchAfter: jest.fn().mockResolvedValue({ punches: [], watermark: '0' }), close: jest.fn() };
    const client = { sendPunches: jest.fn() } as any;

    const agent = new Agent({ config, source, client, logger: silent });
    const res = await agent.tick();

    expect(res).toEqual({ sent: 0, hasMore: false });
    expect(client.sendPunches).not.toHaveBeenCalled();
  });

  /** Cả lô toàn dòng hỏng: phải nhích qua, nếu không agent kẹt vĩnh viễn. */
  it('lô toàn dòng hỏng vẫn đẩy watermark qua', async () => {
    const config = tempConfig();
    const source = { fetchAfter: jest.fn().mockResolvedValue({ punches: [], watermark: '20' }), close: jest.fn() };
    const client = { sendPunches: jest.fn() } as any;

    const agent = new Agent({ config, source, client, logger: silent });
    const res = await agent.tick();

    expect(res.hasMore).toBe(true);
    expect(agent.getState().watermark).toBe('20');
    expect(client.sendPunches).not.toHaveBeenCalled();
  });

  it('lô đầy thì báo còn dữ liệu để chạy tiếp ngay', async () => {
    const config = tempConfig({ batchSize: 2 });
    const source = {
      fetchAfter: jest.fn().mockResolvedValue({ punches: [punch('1'), punch('2')], watermark: '2' }),
      close: jest.fn(),
    };
    const client = { sendPunches: jest.fn().mockResolvedValue(okResult(2)) } as any;

    const agent = new Agent({ config, source, client, logger: silent });
    expect((await agent.tick()).hasMore).toBe(true);
  });

  it('khôi phục watermark đã lưu sau khi khởi động lại', async () => {
    const config = tempConfig();
    writeState(config.statePath, { watermark: '99', lastSuccessAt: null, lastError: null, totalSent: 0 });

    const source = { fetchAfter: jest.fn().mockResolvedValue({ punches: [], watermark: '99' }), close: jest.fn() };
    const agent = new Agent({ config, source, client: { sendPunches: jest.fn() } as any, logger: silent });
    await agent.tick();

    expect(source.fetchAfter).toHaveBeenCalledWith('99', config.batchSize);
  });
});

describe('Agent.run', () => {
  it('thử lại lỗi tạm rồi chạy tiếp', async () => {
    const config = tempConfig();
    const source = {
      fetchAfter: jest.fn()
        .mockRejectedValueOnce(new TransientError('mạng đứt'))
        .mockResolvedValue({ punches: [], watermark: '0' }),
      close: jest.fn(),
    };
    const agent = new Agent({
      config, source, client: { sendPunches: jest.fn() } as any, logger: silent,
      sleep: async () => { if (source.fetchAfter.mock.calls.length >= 2) agent.stop(); },
    });

    await agent.run();
    expect(source.fetchAfter.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(agent.getState().lastError).toBe('mạng đứt');
  });

  /** Sai API key thì thử lại vô ích — phải dừng để người ta biết mà sửa. */
  it('dừng hẳn khi gặp lỗi vĩnh viễn', async () => {
    const config = tempConfig();
    const source = {
      fetchAfter: jest.fn().mockResolvedValue({
        punches: [{ externalId: '1', employeeCode: 'NV001', punchedAt: '2026-09-02T08:00:00+07:00' }],
        watermark: '1',
      }),
      close: jest.fn(),
    };
    const client = {
      sendPunches: jest.fn().mockRejectedValue(new PermanentError('Token thiếu scope', 403)),
    } as any;

    const agent = new Agent({ config, source, client, logger: silent, sleep: async () => {} });
    await expect(agent.run()).rejects.toBeInstanceOf(PermanentError);
    expect(client.sendPunches).toHaveBeenCalledTimes(1);
  });
});
