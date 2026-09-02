# SolidSuite — Agent chấm công

Chạy trong mạng công ty, đọc dữ liệu chấm công từ PostgreSQL của công ty và đẩy
về SolidSuite ERP qua HTTPS.

**Chỉ gọi ra.** Không mở cổng nào vào mạng công ty, không cần VPN, không cần
public database ra internet.

## Cài đặt

### Docker (khuyến nghị)

```bash
docker build -t solid-attendance-agent .

docker run -d --name attendance-agent --restart unless-stopped \
  -e ERP_BASE_URL="https://erp.123website.com.vn" \
  -e ERP_API_KEY="att_..." \
  -e ERP_DEVICE_CODE="MCC01" \
  -e SOURCE_DATABASE_URL="postgres://user:pass@10.0.0.5:5432/chamcong" \
  -v attendance-agent-state:/var/lib/solid-attendance-agent \
  -v "$PWD/config.json:/app/config.json:ro" \
  solid-attendance-agent
```

### Node trực tiếp

```bash
npm install
npm run build
node dist/index.js ./config.json
```

## Cấu hình

Copy `config.example.json` thành `config.json` rồi sửa. **Bí mật đặt bằng biến
môi trường**, đừng viết vào file đem đi copy:

| Biến môi trường | Ghi đè trường |
|---|---|
| `ERP_BASE_URL` | `erp.baseUrl` |
| `ERP_API_KEY` | `erp.apiKey` |
| `ERP_DEVICE_CODE` | `erp.deviceCode` |
| `SOURCE_DATABASE_URL` | `source.connectionString` |
| `BATCH_SIZE` | `batchSize` |
| `INTERVAL_SECONDS` | `intervalSeconds` |
| `STATE_PATH` | `statePath` |

### Câu truy vấn

Agent không đoán tên bảng — mỗi công ty một cấu trúc. Bạn viết câu truy vấn, với
`$1` là watermark hiện tại và `$2` là số dòng tối đa:

```sql
SELECT id, employee_code, punched_at, direction, method
FROM attendance_logs
WHERE id > $1::bigint
ORDER BY id ASC
LIMIT $2
```

Hai yêu cầu bắt buộc:

1. **Phải có `ORDER BY`** theo đúng cột watermark, **tăng dần**. Không có thì
   thứ tự trả về là tuỳ hứng của PostgreSQL và agent sẽ bỏ sót dữ liệu vĩnh
   viễn. Agent từ chối khởi động nếu thiếu.
2. **Cột watermark phải tăng đơn điệu** — id tự tăng là tốt nhất. Nếu dùng
   `punched_at` thì dữ liệu chèn lùi (máy đồng bộ muộn) sẽ bị bỏ qua.

`columns` khai cột nào ứng với trường nào trong payload gửi ERP.

## Cách hoạt động

```
đọc từ watermark → gửi ERP → ERP xác nhận → mới nhích watermark
```

Thứ tự đó là thứ bảo đảm không mất dữ liệu. Hỏng ở bất cứ bước nào thì watermark
đứng yên, nhịp sau đọc lại đúng đoạn đó. Gửi trùng vô hại: ERP chống trùng theo
`externalId` và theo `Idempotency-Key` của cả lô.

Vì vậy agent **không cần hàng đợi cục bộ**. Trạng thái duy nhất phải giữ là
`state.json` — hãy đặt nó trên ổ đĩa bền, đừng để trong `/tmp`.

### Xử lý lỗi

| Loại | Ví dụ | Hành vi |
|---|---|---|
| Tạm | mất mạng, timeout, HTTP 5xx, 429 | Thử lại, backoff luỹ thừa có nhiễu, trần 60s. Watermark đứng yên. |
| Vĩnh viễn | 401 token sai, 403 thiếu scope, 404 chưa khai máy, 400 payload sai | **Dừng hẳn** và ghi log. Thử lại vô ích, cần người sửa cấu hình. |

Dòng thiếu khoá hoặc thiếu thời gian bị bỏ tại chỗ và ghi log. Nếu cả lô toàn
dòng hỏng, watermark vẫn nhích qua — nếu không agent sẽ kẹt vĩnh viễn ở đó.

### Múi giờ

Gửi thời điểm quẹt kèm offset (`2026-09-02T08:05:12+07:00`) là tốt nhất. Cột
`timestamptz` của PostgreSQL tự ra đúng dạng này.

Nếu cột là `timestamp` không múi giờ, agent gửi nguyên chuỗi giờ địa phương và
ERP hiểu theo **múi giờ đã khai cho máy chấm công** trong ERP. Khai sai múi giờ ở
đó sẽ lệch ngày công — kiểm tra lại khi khai máy.

## Kiểm tra hoạt động

Xem log agent:

```bash
docker logs -f attendance-agent
```

Xem phía ERP: **Cài đặt Nhân sự → Máy chấm công** — cột "Đồng bộ gần nhất" và tab
"Nhật ký đồng bộ" cho biết từng lô nhận được bao nhiêu, trùng bao nhiêu, từ chối
bao nhiêu.

Nếu tab **"Mã chưa khớp"** có dữ liệu: mã nhân viên trên máy chưa map sang nhân
viên trong ERP. HR gán trên giao diện, công sẽ được tính lại ngay.

## Tài liệu API

Chi tiết endpoint, các trường và mã lỗi: `docs/attendance-device-integration.md`.
