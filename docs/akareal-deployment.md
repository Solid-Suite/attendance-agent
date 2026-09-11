# Hướng dẫn triển khai agent chấm công — Akareal

Tài liệu dành cho đội IT Akareal. Agent chạy trong mạng nội bộ của Akareal,
đọc dữ liệu từ PostgreSQL bằng tài khoản chỉ có quyền `SELECT`, sau đó gửi dữ
liệu chấm công tới SolidSuite qua HTTPS.

## 1. Mô hình kết nối

```text
PostgreSQL chấm công ──mạng nội bộ──> attendance-agent ──HTTPS/443──> SolidSuite
```

- Không mở PostgreSQL ra Internet.
- Không cần mở cổng inbound vào máy chạy agent.
- Máy chạy agent phải truy cập được PostgreSQL nội bộ và Internet qua HTTPS.
- Không cài agent trên máy chủ SolidSuite.

## 2. Thông tin cần chuẩn bị

### SolidSuite cung cấp

- `ERP_BASE_URL`
- `ERP_API_KEY` bắt đầu bằng `att_`
- `ERP_DEVICE_CODE`, dự kiến `AKAREAL-MCC01`

### IT Akareal chuẩn bị

- Một máy Linux/VM chạy liên tục, có Docker Engine và Docker Compose v2.
- Kết nối từ máy đó tới PostgreSQL chấm công.
- Tài khoản PostgreSQL chỉ có quyền `CONNECT`, `USAGE` schema và `SELECT` bảng/view cần đọc.
- Tên schema, bảng và các cột tương ứng:
  - ID bản ghi tăng dần, duy nhất
  - mã nhân viên
  - thời gian quẹt thẻ
  - chiều vào/ra, nếu có
  - phương thức chấm công, nếu có

Không gửi mật khẩu PostgreSQL hoặc ERP token qua email/chat công khai.

## 3. Chuẩn bị tài khoản PostgreSQL chỉ đọc

Ví dụ dưới đây cần thay tên database, schema và bảng cho đúng hệ thống thực tế:

```sql
CREATE ROLE solidsuite_attendance LOGIN PASSWORD '<MAT_KHAU_MANH>';
GRANT CONNECT ON DATABASE <DATABASE_NAME> TO solidsuite_attendance;
GRANT USAGE ON SCHEMA <SCHEMA_NAME> TO solidsuite_attendance;
GRANT SELECT ON TABLE <SCHEMA_NAME>.<TABLE_CHAM_CONG> TO solidsuite_attendance;
```

Không cấp `SUPERUSER`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` hoặc quyền thay
đổi schema. Có thể tạo một view chỉ chứa các cột cần thiết rồi chỉ cấp `SELECT`
trên view đó.

Kiểm tra tài khoản trước khi cài agent:

```bash
psql 'postgresql://solidsuite_attendance:<MAT_KHAU>@<DB_HOST>:5432/<DATABASE_NAME>' \
  -c 'SELECT * FROM <SCHEMA_NAME>.<TABLE_CHAM_CONG> LIMIT 5;'
```

## 4. Tải bộ cài

```bash
git clone https://github.com/Solid-Suite/attendance-agent.git
cd attendance-agent
cp .env.example .env
cp config.example.json config.json
```

Repository và image GHCR đều public. Không cần tài khoản GitHub hoặc
`docker login`.

## 5. Cấu hình `.env`

Mở `.env` và điền các giá trị thực tế:

```dotenv
ERP_BASE_URL=https://erp.123website.com.vn
ERP_API_KEY=att_<TOKEN_DO_SOLIDSUITE_CAP>
ERP_DEVICE_CODE=AKAREAL-MCC01
SOURCE_DATABASE_URL=postgresql://solidsuite_attendance:<MAT_KHAU>@<DB_HOST>:5432/<DATABASE_NAME>
AGENT_VERSION=0.1.0
```

Nếu mật khẩu có ký tự đặc biệt như `@`, `:`, `/`, `#` hoặc `%`, phải URL-encode
phần mật khẩu trong connection string.

Giới hạn quyền đọc file chứa bí mật:

```bash
chmod 600 .env
```

## 6. Cấu hình câu SQL trong `config.json`

Chỉ sửa `source.query`, `source.columns`, `source.watermarkColumn` và
`source.initialWatermark` theo cấu trúc database Akareal.

Ví dụ:

```json
{
  "erp": {
    "baseUrl": "ĐẶT_BẰNG_ENV",
    "apiKey": "ĐẶT_BẰNG_ENV",
    "deviceCode": "ĐẶT_BẰNG_ENV",
    "timeoutMs": 30000
  },
  "source": {
    "type": "postgres",
    "connectionString": "ĐẶT_BẰNG_ENV",
    "query": "SELECT id AS external_id, employee_code, punched_at FROM public.attendance_logs WHERE id > $1::bigint ORDER BY id ASC LIMIT $2",
    "columns": {
      "externalId": "external_id",
      "employeeCode": "employee_code",
      "punchedAt": "punched_at"
    },
    "watermarkColumn": "external_id",
    "initialWatermark": "0"
  },
  "batchSize": 500,
  "intervalSeconds": 60,
  "statePath": "/var/lib/solid-attendance-agent/state.json"
}
```

Yêu cầu bắt buộc đối với câu SQL:

1. `$1` là watermark: chỉ lấy bản ghi có ID lớn hơn lần đọc trước.
2. `$2` là giới hạn số dòng của một lô.
3. Phải có `ORDER BY` tăng dần theo đúng cột ID/watermark.
4. `externalId` phải ổn định và duy nhất.
5. `employeeCode` phải là mã nhân viên được dùng để mapping trên SolidSuite.
6. `punchedAt` phải là thời gian quẹt thẻ. Ưu tiên kiểu `timestamptz` hoặc giá trị có múi giờ.

Không dùng thời gian làm watermark nếu database có thể ghi bổ sung bản ghi cũ.
Ưu tiên khóa số tăng dần hoặc sequence của bảng chấm công.

## 7. Chạy thử, chưa gửi dữ liệu

```bash
docker compose pull
docker compose run --rm attendance-agent \
  node dist/index.js /app/config.json --dry-run
```

Chế độ `--dry-run` chỉ đọc một lô và hiển thị tối đa 5 dòng mẫu:

- không gọi API SolidSuite;
- không gửi dữ liệu;
- không cập nhật watermark.

Chỉ chuyển sang chạy thật khi log xác nhận kết nối PostgreSQL thành công, tên
cột đúng và dữ liệu mẫu có đủ `externalId`, `employeeCode`, `punchedAt`.

## 8. Chạy chính thức

```bash
docker compose up -d
docker compose ps
docker compose logs --tail=100 -f attendance-agent
```

Container có chính sách `restart: unless-stopped`, nên sẽ tự chạy lại sau khi
máy chủ khởi động.

## 9. Kiểm tra nghiệm thu

IT Akareal và SolidSuite cùng kiểm tra:

- Container có trạng thái `Up`.
- Log không có lỗi kết nối PostgreSQL hoặc HTTP `401`, `403`, `404`.
- SolidSuite hiển thị thời gian đồng bộ gần nhất của máy `AKAREAL-MCC01`.
- Có bản ghi trong Nhật ký đồng bộ.
- Đối chiếu tối thiểu 5 lượt quẹt giữa PostgreSQL và SolidSuite.
- Kiểm tra mã nhân viên chưa mapping trên SolidSuite và gán đúng nhân sự.
- Kiểm tra giờ quẹt và ngày công không bị lệch múi giờ.

## 10. Vận hành

Xem trạng thái và log:

```bash
docker compose ps
docker compose logs --tail=200 attendance-agent
```

Khởi động lại sau khi sửa cấu hình:

```bash
docker compose up -d --force-recreate
```

Nâng cấp có kiểm soát:

```bash
# Đổi AGENT_VERSION trong .env trước khi chạy
docker compose pull
docker compose up -d
```

Không xóa volume `attendance-agent-state`. Volume này lưu watermark để agent
đọc tiếp từ đúng vị trí sau khi restart.

## 11. Thông tin cần gửi SolidSuite khi cần hỗ trợ

Không gửi `.env` nguyên file. Chỉ gửi:

- phiên bản image (`AGENT_VERSION`);
- thời điểm xảy ra lỗi;
- khoảng 100 dòng log liên quan;
- câu SQL đã che tên nhạy cảm nếu cần;
- tên các cột và kiểu dữ liệu;
- mã máy `ERP_DEVICE_CODE`;
- tiền tố token, không gửi toàn bộ token;
- kết quả `docker compose ps`.

