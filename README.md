# Codex → Antigravity Autonomous Harness

Harness local này biến Codex thành quản lý/reviewer duy nhất và Antigravity thành worker chạy nền. Bạn đưa một mục tiêu; Codex tự tạo ledger nội bộ, giao việc, review, gửi lỗi quay lại Antigravity và lặp đến khi hoàn thành. Task không cần người dùng quản lý.

## Chức năng

- Codex: nhận một mục tiêu, cấp toàn quyền trong `scopeIn`, khóa `scopeOut`, giao việc, duyệt hoặc yêu cầu sửa.
- Antigravity: xem việc khả dụng, nhận việc, báo chặn, nộp file hoặc artifact, kết quả test và bằng chứng cho từng tiêu chí.
- Antigravity: báo cáo tiến độ trung gian bằng phần trăm, ghi chú và heartbeat.
- Background runner: tự gọi Antigravity thực thi và Codex review cho đến khi project hoàn thành, với retry có giới hạn để tránh vòng lặp tốn quota.
- Codex status: xem project, task board, tiến độ, agent session, heartbeat và task chờ review trực tiếp trong Codex.
- Kiểm soát: dependency gate, trạng thái hữu hạn, bắt buộc bằng chứng, lịch sử sự kiện và SQLite WAL cho hai client chạy đồng thời.

## Yêu cầu

- Windows 10/11.
- Node.js 22.5 trở lên (`node --version`).
- Codex CLI đã đăng nhập (`codex --version`).
- Google Antigravity IDE/2.0/CLI đã cài.

## Cài tự động trên Windows

Cách ngắn nhất từ PowerShell hoặc Command Prompt:

```cmd
install.cmd
doctor.cmd
```

Kiểm tra toàn hệ thống bằng `doctor.cmd`.

Mở PowerShell tại thư mục bộ kit và chạy:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install-windows.ps1
```

Script cài dependency, build, chạy test, cài plugin Codex, sao lưu rồi cập nhật MCP của Antigravity. Database mặc định là `%USERPROFILE%\.codex-antigravity-pm\project.db`.

Nếu Codex Desktop đang khóa plugin cache, installer tự cấu hình `antigravity_pm` trực tiếp tới `server/dist/index.js`. Server mới vẫn hoạt động; có thể cài lại plugin sau khi đóng Codex để cập nhật skill/package cache.

Sau đó:

1. Khởi động lại Codex để plugin và skill được nạp trong task mới.
2. Trong Antigravity: Agent panel → `...` → MCP Servers → Manage MCP Servers → Refresh.
3. Với Antigravity CLI, chạy `agy`, sau đó `/mcp`.

Kết nối ổn định:

- Chỉ dùng một database chung trong `%USERPROFILE%\.codex-antigravity-pm\project.db`; không tạo DB riêng cho Codex và Antigravity.
- Sau khi sửa config, refresh MCP trong Antigravity và mở task Codex mới để nạp lại plugin.
- Chạy `doctor.cmd`; nếu MCP không hiện, chạy lại `install.cmd` rồi `configure-antigravity.ps1`.
- Không chạy hai runner cho cùng một `projectId`; dùng `project_worker_status` trước khi start.

Nếu log runner có `MCP tool call requires approval, but approval policy is never`, cập nhật plugin từ Git rồi chạy lại `install.cmd`; review runner đã chuyển sang `--approve-for-me` để cho phép MCP mutation như `task_review`.

Nếu log có `UNAUTHENTICATED` hoặc `Eligibility check failed`, chạy `agy` trực tiếp trong terminal để đăng nhập lại và kiểm tra DNS/proxy tới Google Cloud Code Assist. Đây là lỗi xác thực/mạng của Antigravity, không phải lỗi chia task.

## Cài thủ công

### 1. Build server

```powershell
cd .\plugins\codex-antigravity-pm\server
npm install
npm test
```

### 2. Kết nối Codex

```powershell
codex plugin marketplace add "<DUONG_DAN_TUYET_DOI_DEN_THU_MUC_KIT>"
codex plugin add codex-antigravity-pm@codex-antigravity-local
codex plugin list
```

Plugin khởi chạy `antigravity_pm` ở vai trò `manager`. Antigravity CLI dùng server worker và cùng database.

Nếu không muốn cài plugin, có thể thêm server trực tiếp:

```powershell
codex mcp add antigravity-pm --env PM_ROLE=manager --env PM_ACTOR=codex --env "PM_DB_PATH=$env:USERPROFILE\.codex-antigravity-pm\project.db" -- node "<DUONG_DAN_TUYET_DOI>\server\dist\index.js"
codex mcp list
```

### 3. Kết nối Antigravity

Cách an toàn nhất là chạy script merge cấu hình (script tạo bản sao lưu trước khi ghi):

```powershell
.\plugins\codex-antigravity-pm\scripts\configure-antigravity.ps1
```

Hoặc mở `~/.gemini/config/mcp_config.json` từ Antigravity và thêm mục sau vào `mcpServers` (thay hai đường dẫn tuyệt đối):

```json
{
  "mcpServers": {
    "codex-antigravity-pm": {
      "command": "node",
      "args": ["C:\\ABSOLUTE\\PATH\\server\\dist\\index.js"],
      "env": {
        "PM_ROLE": "worker",
        "PM_ACTOR": "antigravity",
        "PM_DB_PATH": "C:\\Users\\YOUR_NAME\\.codex-antigravity-pm\\project.db"
      }
    }
  }
}
```

Không thay toàn bộ file nếu đã có MCP khác; chỉ merge khóa `codex-antigravity-pm` vào `mcpServers`.

## Cách dùng một lệnh

Trong Codex:

```text
Gọi project_run cho repository C:\work\my-app.
Mục tiêu: hoàn thiện chức năng đăng nhập.
scopeIn: src/auth, tests/auth, package.json.
scopeOut: database production, deployment, unrelated modules.
acceptanceCriteria: đăng nhập thành công, lỗi hợp lệ, test pass.
verificationCommands: npm test.
Tự giao Antigravity, review, request_changes khi lỗi, lặp đến approved.
```

`project_run` trả về `projectId` và `taskId`, nhưng đây là ID nội bộ để tra cứu; bạn không cần thao tác task thủ công.

Nếu quên `projectId`:

```text
Gọi project_list. Tìm project có repositoryPath là C:\work\my-app và trả về projectId cùng updatedAt.
```

Chế độ thủ công trong Antigravity (chỉ dùng khi cần debug):

```text
Dùng codex-antigravity-pm. Gọi task_next cho project <PROJECT_ID>, claim task ưu tiên cao nhất, đọc toàn bộ đặc tả, triển khai trong repo, chạy verification commands rồi gọi task_submit với changed files, kết quả test và bằng chứng cho từng acceptance criterion. Nếu thiếu quyền hoặc dữ liệu, gọi task_block; không tự mở rộng phạm vi.
```

Trong lúc làm task, Antigravity nên cập nhật tiến độ định kỳ:

```text
Gọi task_progress cho task <TASK_ID> với percent 40 và note "Đã hoàn tất phần API; đang viết test".
```

Theo dõi tiến độ từ Codex:

```text
Gọi project_status cho project <PROJECT_ID>. Hiển thị active tasks, progressPercent, progressNote và heartbeatAt.
```

Theo dõi trực quan:

```cmd
doctor.cmd
```

Codex tự hiển thị trạng thái qua `project_status`, `session_list`, `health_check` và `event_list`.

Khôi phục task bị claim nhưng worker đã chết:

```text
Gọi project_recover cho project <PROJECT_ID> với staleAfterSeconds 180. Sau đó gọi project_worker_start nếu runner chưa chạy.
```

`project_status` hiện trả thêm `workers` và `alerts`. Codex chỉ requeue tự động khi không còn worker heartbeat. Muốn thu hồi thủ công một task, dùng `task_requeue`; `force=true` chỉ dành cho trường hợp đã xác nhận worker cũ cần bị thay thế.

Trở lại Codex:

```text
Kiểm tra các task submitted của project <PROJECT_ID>. Đọc thay đổi thực tế trong repo và đối chiếu từng acceptance criterion. Chỉ gọi task_review approve khi mọi test và bằng chứng đạt; nếu không, request_changes với finding và next action cụ thể.
```

Chạy toàn bộ project nền từ Codex:

```text
Gọi project_worker_start cho project <PROJECT_ID>. Dùng repositoryPath của project và pollSeconds 20. Sau đó báo trạng thái worker.
```

Implementation turn mặc định được chờ tối đa 120 phút. Với tác vụ dài, truyền `turnTimeoutMinutes` từ 10 đến 480 khi gọi `project_run` hoặc `project_worker_start`. Timeout chỉ giới hạn một lượt Antigravity; không yêu cầu chia nhỏ task.

Worker implementation mặc định dùng `gemini-3.8-flash-high` với reasoning effort `high`.

Runner dừng tự động khi mọi task được approved. Nếu task bị blocked, runner giữ nguyên dữ liệu và chờ bạn/Codex cập nhật specification.

### Bảo vệ quota

Runner mặc định chỉ cho phép **1 lần chạy task/review** trong một phiên. Nếu tiến trình kết thúc mà task vẫn `claimed`, review không xử lý `submitted`, hoặc lệnh lỗi, runner sẽ dừng/block thay vì gọi lại vô hạn. Có thể tăng có chủ ý bằng biến môi trường `PM_MAX_ATTEMPTS=2` (tối đa 5); retry dùng exponential backoff, tối đa 300 giây. Script start dùng mutex chống mở hai runner cùng project; script stop dừng cả process con. Sau khi sửa nguyên nhân, dùng `task_requeue` để chạy lại thủ công.

## Luồng nội bộ

```text
ready → claimed → submitted → approved
                  ↘ changes_requested → claimed → ...
ready/claimed/changes_requested → blocked
claimed/blocked → ready (task_requeue hoặc project_recover)
```

Task có dependency chỉ xuất hiện trong `task_next` sau khi mọi dependency đã được `approved`.

## Gỡ cài đặt

```powershell
codex plugin remove codex-antigravity-pm
codex plugin marketplace remove codex-antigravity-local
```

Trong Antigravity, xóa khóa `codex-antigravity-pm` khỏi `~/.gemini/config/mcp_config.json`. Database không bị xóa tự động để tránh mất lịch sử.

## Tài liệu chính thức

- Codex MCP: https://developers.openai.com/codex/mcp
- Antigravity MCP: https://antigravity.google/docs/ide-mcp
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/get-started/first-server.md
