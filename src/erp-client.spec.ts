import { ErpClient, PermanentError, TransientError, type PunchPayload } from './erp-client';

describe('ErpClient', () => {
  const defaultOpts = {
    baseUrl: 'https://erp.example.com',
    apiKey: 'att_secret_key_123',
    deviceCode: 'MCC01',
    timeoutMs: 1000,
  };

  const samplePunches: PunchPayload[] = [
    { externalId: 'MCC01:1', employeeCode: 'NV001', punchedAt: '2026-09-02T08:00:00+07:00' },
  ];

  it('gửi payload kèm x-api-key và Idempotency-Key header thành công', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        syncRunId: 'run-1',
        received: 1,
        accepted: 1,
        duplicated: 0,
        rejected: 0,
        aggregated: 1,
        status: 'SUCCESS',
      }),
    });

    const client = new ErpClient({ ...defaultOpts, fetchImpl: mockFetch as any });
    const res = await client.sendPunches(samplePunches, 'watermark-100');

    expect(res.status).toBe('SUCCESS');
    expect(res.accepted).toBe(1);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://erp.example.com/api/hrm/attendance/punches');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('att_secret_key_123');
    expect(init.headers['Idempotency-Key']).toMatch(/^MCC01-[a-f0-9]{32}$/);
    expect(JSON.parse(init.body)).toEqual({
      deviceCode: 'MCC01',
      punches: samplePunches,
      watermark: 'watermark-100',
    });
  });

  it('báo lỗi PermanentError khi gặp HTTP 401 (Sai token) hoặc 403 (Thiếu quyền)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Token không hợp lệ hoặc đã bị thu hồi' }),
    });

    const client = new ErpClient({ ...defaultOpts, fetchImpl: mockFetch as any });
    await expect(client.sendPunches(samplePunches)).rejects.toThrow(PermanentError);
  });

  it('báo lỗi PermanentError khi gặp HTTP 404 (Máy chưa khai báo)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Máy chấm công MCC01 chưa được khai báo' }),
    });

    const client = new ErpClient({ ...defaultOpts, fetchImpl: mockFetch as any });
    await expect(client.sendPunches(samplePunches)).rejects.toMatchObject({
      message: 'Máy chấm công MCC01 chưa được khai báo',
      status: 404,
    });
  });

  it('báo lỗi TransientError khi gặp HTTP 429 (Rate limited) để retry sau', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ message: 'Quá nhiều request, vui lòng thử lại sau' }),
    });

    const client = new ErpClient({ ...defaultOpts, fetchImpl: mockFetch as any });
    await expect(client.sendPunches(samplePunches)).rejects.toThrow(TransientError);
  });

  it('báo lỗi TransientError khi gặp HTTP 500/502/503 (ERP lỗi tạm thời)', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Service Unavailable' }),
    });

    const client = new ErpClient({ ...defaultOpts, fetchImpl: mockFetch as any });
    await expect(client.sendPunches(samplePunches)).rejects.toThrow(TransientError);
  });

  it('báo lỗi TransientError khi mạng bị ngắt hoặc fetch bị reject', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:443'));

    const client = new ErpClient({ ...defaultOpts, fetchImpl: mockFetch as any });
    await expect(client.sendPunches(samplePunches)).rejects.toThrow(TransientError);
  });
});
