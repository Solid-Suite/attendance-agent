#!/usr/bin/env node
/**
 * Điểm vào của agent chấm công.
 *
 * Chạy: `node dist/index.js [đường-dẫn-config.json]`
 * Mặc định đọc `./config.json`, biến môi trường ghi đè được (xem `config.ts`).
 */

import { Agent, consoleLogger } from './agent';
import { ConfigError, loadConfig } from './config';
import { runDryRun } from './dry-run';
import { ErpClient } from './erp-client';
import { PostgresSource } from './source-postgres';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const configPath =
    args.find((a) => !a.startsWith('--')) ?? process.env.AGENT_CONFIG ?? './config.json';

  const config = loadConfig(configPath);
  const source = new PostgresSource(config);

  // Chạy thử: đọc database rồi in ra, không đụng ERP, không ghi watermark.
  // Cho phép thử phần đọc trước khi có token — không phải chờ ai cấp gì cả.
  if (dryRun) {
    try {
      await runDryRun(config, source, consoleLogger);
    } finally {
      await source.close();
    }
    return;
  }

  const client = new ErpClient({
    baseUrl: config.erp.baseUrl,
    apiKey: config.erp.apiKey,
    deviceCode: config.erp.deviceCode,
    timeoutMs: config.erp.timeoutMs,
  });

  const agent = new Agent({ config, source, client });

  // Dừng êm: đóng kết nối tới database của công ty thay vì để treo.
  const shutdown = (signal: string) => {
    consoleLogger.info(`Nhận ${signal}, đang dừng…`);
    agent.stop();
    source.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await agent.run();
  await source.close();
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    consoleLogger.error(`Cấu hình sai: ${err.message}`);
  } else {
    consoleLogger.error(String(err?.message ?? err));
  }
  process.exit(1);
});
