# SolidSuite — Agent chấm công

Chạy trong mạng công ty, đọc dữ liệu chấm công từ PostgreSQL của công ty và đẩy
về SolidSuite ERP qua HTTPS.

**Triển khai cho Akareal:** xem [hướng dẫn cài đặt và nghiệm thu dành cho đội IT](docs/akareal-deployment.md).

**Chỉ gọi ra.** Không mở cổng nào vào mạng công ty, không cần VPN, không cần
public database ra internet.

## Chuẩn bị trước khi cài

Ba bước này phải xong **trước** khi chạy agent. Sai ở đây thì agent không tự
chữa được — nó dừng và ghi log. Đọc log rồi sửa cấu hình, đừng restart hy vọng
sẽ khác.

### 1. Khai máy chấm công trong ERP

Vào **Cài đặt Nhân sự → Máy chấm công** (`/hrm-settings/attendance-devices`).
Cùng màn hình cũng mở được từ **Cài đặt → Máy chấm công**
(`/settings?tab=hrm-attendance-devices`). Tiêu đề trang là **Kết nối máy chấm
công**.

Nhấn **Khai báo máy**. Điền:

| Trường trên form | Ghi vào config agent | Ghi chú |
|---|---|---|
| **Mã máy** (bắt buộc) | `ERP_DEVICE_CODE` / `erp.deviceCode` | Ví dụ `MCC01`. Phân biệt hoa thường. |
| **Tên máy** (bắt buộc) | — | Chỉ để người xem, agent không dùng. |
| **Múi giờ nơi đặt máy** (bắt buộc) | — | Mặc định `Asia/Ho_Chi_Minh`. Agent không gửi múi giờ; ERP lấy từ đây. |

**Mã máy phải trùng từng ký tự** với `ERP_DEVICE_CODE`. Sai thì ERP trả
**HTTP 404** (`Máy chấm công "…" chưa được khai báo trong hệ thống`), agent
ghi `Lỗi cấu hình/quyền (HTTP 404)` rồi **dừng hẳn**. Restart không giúp —
sửa mã cho khớp, hoặc khai thêm máy đúng mã.

Máy đang **Ngưng** thì ERP trả **HTTP 400**, agent cũng dừng. Mở lại máy trên
cùng màn hình rồi chạy lại.

Khai sai **múi giờ** thì agent vẫn chạy, nhưng ngày công lệch. Chỉ lộ khi đối
chiếu giờ quẹt trên máy với bảng công. Xem thêm mục Múi giờ bên dưới.

### 2. Cấp token máy

Vào **Cài đặt → API Tokens** (`/settings?tab=api-tokens`). Tiêu đề trang là
**Tích hợp API Tokens & Webhooks**.

Nhấn **Tạo Token mới**. Chọn loại kết nối **Máy chấm công** (không chọn
**Tích hợp CRM**). Loại này gắn đúng một scope: `hrm.attendance.write`. Token
đúng loại bắt đầu bằng `att_`.

Token máy mặc định **bị khoá ngoài `/api/crm/*`**. Chỉ scope
`hrm.attendance.write` mới mở đúng một đường
`POST /api/hrm/attendance/punches`. Token CRM (`crm.all` hay `*`) **không**
mở được cổng này.

**Token chỉ hiện một lần** lúc tạo. Chép ngay vào biến `ERP_API_KEY`. Đóng hộp
thoại là mất — danh sách sau đó chỉ còn tiền tố (`att_7f50…`). Mất thì thu hồi
cái cũ, tạo cái mới.

Sai thì triệu chứng:

| Lỗi | HTTP | Log agent | Việc phải làm |
|---|---|---|---|
| Token gõ sai, đã thu hồi, hoặc dán nhầm | **401** | `Lỗi cấu hình/quyền (HTTP 401)`. Dừng hẳn. | Tạo lại token, dán đúng chuỗi `att_…` vào `ERP_API_KEY`. |
| Token loại CRM, hoặc thiếu scope `hrm.attendance.write` | **403** | `Lỗi cấu hình/quyền (HTTP 403)`, nội dung kiểu `Token thiếu scope hrm.attendance.write`. Dừng hẳn. | Tạo lại, chọn đúng loại **Máy chấm công**. |

### 3. Chuẩn bị quyền đọc database chấm công

Tạo tài khoản PostgreSQL **chỉ SELECT** trên bảng (hoặc view) mà câu truy vấn
sẽ đọc. Đưa chuỗi kết nối đó vào `SOURCE_DATABASE_URL`.

Agent chỉ `query` — không INSERT/UPDATE. Vẫn **không** được dùng tài khoản có
quyền ghi. Câu SQL nằm trong `config.json`; nếu ai đó sửa thành câu ghi, tài
khoản đủ quyền sẽ ghi được vào hệ thống chấm công của công ty.

Sai thì triệu chứng:

| Lỗi | Việc xảy ra |
|---|---|
| Sai host/port/mật khẩu | PostgreSQL từ chối kết nối. Agent coi là lỗi tạm, thử lại mãi, watermark đứng yên. |
| User không có SELECT trên bảng trong câu truy vấn | Chạy thử (`--dry-run`) log `tài khoản database không có quyền SELECT`. Chạy thật thì PostgreSQL trả `42501`; agent coi là lỗi tạm, log lặp `Lỗi tạm`, watermark đứng. Cấp SELECT rồi thôi. |
| Dùng superuser / user ghi được | Agent chạy bình thường. Không có cảnh báo. Đây là rủi ro vận hành, không phải lỗi phần mềm. |

## Cài đặt

### Docker Compose từ GHCR (khuyến nghị)

Máy cài chỉ cần Docker. Không cần clone toàn bộ SolidSuite, Node.js hay pnpm.

```bash
cp .env.example .env
cp config.example.json config.json
```

Sửa `.env` và `config.json`, sau đó khởi động. Image GHCR là public nên không
cần tài khoản GitHub hay `docker login`:

```bash
docker compose pull
docker compose up -d
docker compose logs -f attendance-agent
```

Image production dùng tag phiên bản cố định:

```text
ghcr.io/solid-suite/attendance-agent:0.1.0
```

Để nâng cấp, đổi `AGENT_VERSION` trong `.env`, rồi chạy lại `docker compose
pull` và `docker compose up -d`.

### Tự build Docker image

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

## Danh sách kiểm trước khi bàn giao

Tick lần lượt trên máy thật. Bỏ bước nào thì đừng chạy agent — triệu chứng nằm
ở cột bên phải.

| ☐ | Việc | Xong khi | Sai thì |
|---|---|---|---|
| ☐ | Khai máy trong ERP | Có máy **Đang chạy** trên Cài đặt Nhân sự → Máy chấm công, mã đúng như sẽ ghi vào config (vd `MCC01`) | Mã lệch → HTTP 404, agent dừng. Máy Ngưng → HTTP 400, agent dừng. |
| ☐ | Múi giờ máy | **Múi giờ nơi đặt máy** đúng nơi đặt thiết bị (thường `Asia/Ho_Chi_Minh`) | Agent chạy, ngày công lệch. |
| ☐ | Token loại Máy chấm công | Đã chọn **Máy chấm công**, chuỗi bắt đầu `att_`, đã chép vào `ERP_API_KEY` lúc tạo | Token CRM / thiếu scope → HTTP 403, dừng. Token sai/thu hồi → HTTP 401, dừng. Quên chép → phải tạo lại, không lấy lại được. |
| ☐ | User PostgreSQL chỉ SELECT | User kết nối được và `SELECT` được đúng bảng trong câu truy vấn; không có quyền INSERT/UPDATE/DELETE | Sai mật khẩu / thiếu SELECT → log `Lỗi tạm` lặp, watermark đứng. |
| ☐ | `config.json` + biến môi trường | `ERP_BASE_URL`, `ERP_API_KEY`, `ERP_DEVICE_CODE`, `SOURCE_DATABASE_URL` khớp bước trên. Bí mật không nằm trong file copy đi | Thiếu biến → agent không khởi động (`Cấu hình sai: …`). |
| ☐ | Câu truy vấn | Có `ORDER BY` theo cột watermark, tăng dần; `$1` watermark, `$2` limit | Thiếu `ORDER BY` → agent từ chối khởi động. |
| ☐ | Ổ đĩa `state.json` | Volume bền, không phải `/tmp` | Mất file thì đọc lại từ watermark ban đầu. Không mất dữ liệu (ERP chống trùng) nhưng tốn một vòng đọc lớn. |
| ☐ | Chạy thử `--dry-run` | Log có `CHẠY THỬ`, in mẫu dòng sẽ gửi, **không** gọi ERP, **không** ghi watermark | Lỗi SQL / map cột / thiếu SELECT lộ ở đây. Sửa query trước khi chạy thật. |
| ☐ | Chạy thật, xem log | `docker logs -f attendance-agent` có `Bắt đầu: máy …`, không có `HTTP 401/403/404` | 4xx vĩnh viễn → dừng, sửa đúng bước trên rồi chạy lại. |
| ☐ | ERP nhận lô | Cột **Đồng bộ gần nhất** đổi; tab **Nhật ký đồng bộ** có lô, số nhận/ghi mới/trùng/từ chối | Agent im quá 2 tiếng thì cột báo máy chết. |
| ☐ | Mã nhân viên | Tab **Mã chưa khớp** trống, hoặc HR đã gán xong | Còn mã ở đây thì công các mã đó chưa được tính — không phải lỗi agent. |

Chạy thử: đọc một lô từ database, in mẫu (tối đa 5 dòng), rồi dừng. **Không**
gọi ERP, **không** ghi `state.json`. Vẫn phải khai đủ biến cấu hình vì agent
đọc config trước — chưa có token thật thì `ERP_API_KEY` tạm để chuỗi bất kỳ.

```bash
# Node
node dist/index.js ./config.json --dry-run

# Docker — phải ghi lại cả lệnh node. Chỉ gắn `--dry-run` sau tên ảnh thì
# Docker thay hết CMD, agent không chạy.
docker run --rm \
  -e ERP_BASE_URL="https://erp.123website.com.vn" \
  -e ERP_API_KEY="att_..." \
  -e ERP_DEVICE_CODE="MCC01" \
  -e SOURCE_DATABASE_URL="postgres://user:pass@10.0.0.5:5432/chamcong" \
  -v "$PWD/config.json:/app/config.json:ro" \
  solid-attendance-agent \
  node dist/index.js /app/config.json --dry-run
```
