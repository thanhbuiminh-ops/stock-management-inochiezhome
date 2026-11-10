# Inochi · Visual Stock

Website xem tồn kho dạng trực quan, đọc dữ liệu từ Google Sheet **"Inochi BMT - Pricing Frame"** (tab `COGS`), host trên Netlify, chỉ tài khoản được cấp mới vào được.
Mặc định ẩn các sản phẩm có TYPE = `Other`; mọi TYPE khác (kể cả TYPE mới bạn thêm sau này) tự hiện thành nút lọc, bấm để bật/tắt.
Có 3 tab: **Tồn kho** (thẻ sản phẩm có ảnh, Bắc/Nam, COGS, giá trị tồn, cảnh báo theo Forecast), **Plan** (dán dữ liệu từ Google Sheet → ghép tên sản phẩm → Confirm) và **Forecast** (các line đã lưu, sửa trực tiếp).

## Kiến trúc

```
Google Sheet ──(service account, chỉ đọc)──> Netlify Function ──> Netlify Blobs (snapshot + forecast)
                                                   ▲                       │
Trình duyệt ──cookie đăng nhập──> Edge gate ───────┴──── /api/stock ───────┘
```

- **Không dùng Boxme API**: số tồn Bắc/Nam đã nằm trong Sheet nên không cần API key/IP whitelist của Boxme.
- **Làm mới lười (lazy refresh)**: khi có người mở trang, nếu snapshot cũ hơn `REFRESH_AFTER_SEC` (mặc định 300s) thì function đọc lại Sheet. Nút "Làm mới" ép đọc lại (cooldown 15s). Không có ai xem thì không tốn lượt gọi.
- Đọc Sheet lỗi → giữ nguyên snapshot cũ, hiện banner cảnh báo (không ghi đè dữ liệu tốt bằng dữ liệu hỏng).
- Cột được đọc theo **tên tiêu đề** (không theo vị trí): Master SKU, TYPE, Boxme Bắc, Boxme Nam (bắt buộc); Link Ảnh, Product Name, Short Name, Category, COGS, Total Stock_BM, Status Boxme_Bắc, Status Boxme_Nam (tuỳ chọn). Đổi tên tiêu đề → web báo lỗi rõ ràng.
- COGS và "Giá trị tồn" **hiện mặc định cho mọi tài khoản đã đăng nhập**. Đặt `INCLUDE_COST=false` để ẩn (khi đó COGS không được gửi xuống trình duyệt).
- Cột Status của Sheet **không còn được đọc**; cảnh báo tính từ Forecast (mục dưới).
- **Forecast KHÔNG nằm trong Google Sheet**: nó được nhập/sửa trên web và lưu trong Netlify Blobs (web không ghi ngược vào Sheet). Nếu cần backup, dùng nút CSV ở tab Forecast.

## Plan → Forecast (nhập kế hoạch bán hàng)
**Tab Plan**
1. Copy vùng bảng trong Google Sheet (cột `Campaign Type · Loại (Main/Gift) · Tên sản phẩm · Số lượng · RSP (Main)/COGS (Gift)`, thêm `Max CIR` nếu có) rồi dán vào ô, chọn *Tháng áp dụng*, bấm **Phân tích & ghép sản phẩm**. Không cần cột SKU.
2. Web tự ghép **tên → SKU** (bỏ dấu, so khớp từ, ưu tiên số/dung tích như `4L`, `500ml`, chịu được tên bị cắt). Mỗi dòng có nhãn *Khớp / Gần giống / Chưa khớp*; ô chọn sản phẩm cho phép **gõ tìm lại** và chọn sản phẩm khác (Main lẫn quà). Bộ chọn tìm trong **mọi** TYPE (quà thường là TYPE Other).
3. Bấm **Confirm** → lưu vào Forecast và tự chuyển sang tab Forecast. Line trùng (cùng tháng + campaign + Main) được nhắc để bạn không nhập đôi.

**Tab Forecast** — mỗi line sửa trực tiếp: đổi Main, giá bán, campaign, tháng, SL dự kiến, Max CIR, thêm/xoá/đổi quà (sản phẩm, số lượng, giá vốn). **Tự lưu** sau ~0,7 giây khi ngừng gõ; hai người sửa cùng một line thì người sau nhận cảnh báo "đã bị người khác sửa" thay vì ghi đè. Xem được theo *line* hoặc gộp theo *SKU* (nhu cầu Main + quà, tồn Bắc/Nam, độ phủ).

**CIR** = Σ(số lượng quà × giá vốn quà) ÷ Giá bán (RSP); **Over** khi CIR (chưa làm tròn) > Max CIR. Max CIR mặc định theo ảnh Sheet bạn gửi: `BAU` 4%, `MINI SPIKE` 5%; campaign khác (vd `MINPRICE`) chưa có số nên hiện "Chưa có Max CIR" cho tới khi bạn nhập tay trên line.
Biên gộp = (giá bán − COGS Main) ÷ giá bán; "Sau quà" = giá bán − COGS Main − vốn quà (**chưa** trừ phí sàn/ads/voucher). Công thức *Biên Ròng / Lợi nhuận / Vượt Quota* của tool khác bạn dùng **chưa được tái tạo** vì chưa biết công thức.

**Cảnh báo tồn thấp** chỉ áp cho SKU có trong Forecast của **tháng tới** (theo giờ Việt Nam). Nhu cầu mỗi SKU = Σ(SL dự kiến của Main) + Σ(SL dự kiến × số quà) — quà tặng cũng trừ tồn. Line chưa nhập *SL dự kiến* thì chưa tính nhu cầu. So với tồn hiện có trong Sheet:
| Mức | Điều kiện |
|---|---|
| Hết hàng | Tổng tồn = 0 |
| Thiếu so plan | Tổng tồn < nhu cầu |
| Kho Nam thiếu | Tồn Nam < nhu cầu × `PLAN_SOUTH_SHARE_PCT`% (mặc định 70) — kèm gợi ý lượng Bắc có thể chuyển |
| Sát plan | Tổng tồn < nhu cầu × (1 + `PLAN_BUFFER_PCT`%) (mặc định 20) |
| Đủ plan | còn lại |

⚠️ Hai tỉ lệ 70% và 20% là **giả định tạm** của người viết, hãy chỉnh theo thực tế. Cảnh báo **chưa tính hàng đang về** (Sheet không có dữ liệu đó), nên "Thiếu" nghĩa là *chưa tính PO đang về*.

> ⚠️ "Cập nhật lúc …" trên dashboard là lúc **website đọc Sheet**, không phải lúc Boxme cập nhật tồn. Độ tươi thật của số tồn phụ thuộc cách Sheet nhận dữ liệu Boxme (tab Tồn Kho, Apps Script…).

## Cài đặt (làm 1 lần)

### 1. Service account để đọc Sheet
1. Google Cloud Console → tạo project → **APIs & Services → Enable APIs → Google Sheets API**.
2. **IAM & Admin → Service Accounts → Create** → tab *Keys* → *Add key → JSON* (tải file về).
3. Mở Google Sheet → **Share** → dán `client_email` trong file JSON → quyền **Viewer**.
4. `SHEET_ID` là đoạn giữa trong URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.

### 2. Tạo tài khoản đăng nhập
```bash
npm install
npm run hash-password -- ten@email.com     # nhập mật khẩu (ẩn), copy dòng "email": "scrypt$..."
```
Gộp các dòng thành 1 JSON: `{"a@gmail.com":"scrypt$...","b@gmail.com":"scrypt$..."}`

### 3. Biến môi trường trên Netlify (Site configuration → Environment variables)
Xem `.env.example`. Tối thiểu: `SESSION_SECRET` (`openssl rand -base64 48`), `USERS_JSON`, `SHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` (dán nguyên `private_key` trong file JSON, giữ cả `\n`).

### 4. Deploy
Kéo thả thư mục này lên Netlify, hoặc nối Git repo (build command để trống, publish `public`).
Sau khi deploy: mở bằng **cửa sổ ẩn danh** → phải bị chuyển về trang đăng nhập; `/api/stock` khi chưa đăng nhập phải trả 401.

## Quản lý người dùng
- Thêm người: tạo hash → thêm vào `USERS_JSON` → deploy lại.
- Thu hồi: xoá email khỏi `USERS_JSON` → deploy lại. Cổng kiểm tra lại danh sách ở mỗi request nên cookie cũ của người đó mất hiệu lực ngay sau deploy.
- Phiên đăng nhập 12 giờ. Sai mật khẩu 5 lần (email có trong danh sách) → khoá 15 phút.

## Kiểm thử
`npm test` — 51 test: session, mật khẩu, đăng nhập/khoá, edge gate, parser Sheet, Google client với server giả (kiểm chữ ký RS256 JWT), TTL/cooldown/giữ snapshot khi lỗi, API cần xác thực, ẩn COGS, **Forecast** (thêm/sửa/xoá, kiểm tra dữ liệu, xung đột 409, 12 người ghi đồng thời không mất dòng), nhu cầu Main + quà, các mức cảnh báo, **parser dữ liệu dán**, ghép tên gần giống, công thức CIR, và ràng buộc CSP của frontend (không innerHTML/inline script/style).

## Chưa kiểm chứng (cần bạn xác nhận khi deploy)
- Chưa chạy với Google Sheet thật và Netlify thật (chỉ test với server giả + trình duyệt headless chạy qua đúng các handler thật). Tên sản phẩm trong tab Plan của bạn chưa được đối chiếu với tên trong tab COGS thật nên tỉ lệ tự ghép đúng chưa biết trước.
- Netlify Blobs: logic ghi có điều kiện (etag) kiểm theo định nghĩa kiểu của `@netlify/blobs` 11.1.9 và store giả; chưa chạy trên Blobs thật.
- Edge Function chưa được bundler của Netlify build thử trong môi trường dựng (sandbox không tải được Deno); đã kiểm tra bằng esbuild và test logic.
- Biến `AWS_LAMBDA_JS_RUNTIME` trong `netlify.toml` chưa xác minh; `NODE_VERSION=22` là phần chắc chắn cần (gói `@netlify/blobs` v11 yêu cầu Node ≥ 22.12).
- Số tồn trong Sheet cập nhật weekly nên có thể cũ tới 7 ngày; cảnh báo dựa trên số đó.
#   s t o c k - m a n a g e m e n t - i n o c h i e z h o m e  
 