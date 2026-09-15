# Tối ưu Codex -> Antigravity PM

## Đã hoàn thành

- Khóa một database chung, repository tuyệt đối, scope tương đối an toàn và assignee chính xác.
- Chặn path traversal, absolute path, NTFS alternate data stream, wildcard trong changed files và scope bypass khác hoa/thường trên Windows.
- Chặn dependency trùng, khác project, cycle; bảo vệ live worker khi recover/requeue.
- Bắt buộc changed file/artifact, verification evidence và acceptance evidence đầy đủ, không trùng; chỉ approve khi mọi mục `passed`.
- Thêm `project_wait` long-poll tối đa 50 giây; trả event mới, `completed`, `needs_attention` hoặc timeout.
- Thêm state/alert rõ cho no-task, blocked, stale claim, runner failure; runner dừng thay vì retry vô hạn.
- Antigravity cố định `gemini-3.8-flash-high`, effort `high`, sandbox, timeout 10-480 phút; không commit/push/cài dependency ngoài task.
- Codex review dùng `--approve-for-me`; launcher hỗ trợ Windows PowerShell 5.1 và path có khoảng trắng.
- Installer tránh plugin-cache lock bằng direct MCP fallback. Antigravity config ghi UTF-8 không BOM.
- Doctor kiểm tra Node, Antigravity CLI/MCP, model/sandbox, Codex MCP, DB và đường dẫn executable.

## P1 - nên làm trước production nhiều worker

1. Gói mỗi state transition và event audit trong một SQLite transaction.
2. Thêm test tranh chấp claim/requeue bằng nhiều process, không chỉ nhiều connection.
3. Ghi runner PID, start time, last error và trạng thái vào SQLite thay vì file/log riêng.
4. Đối chiếu `changedFiles` với Git diff thực tế trước khi nhận submission.

## P2 - vận hành dài hạn

1. Thêm migration version table; bỏ bắt lỗi chuỗi `duplicate column name`.
2. Thêm pagination cho task/event/session list.
3. Thêm CI Windows cho build, test, installer, doctor và PowerShell 5.1 launcher.
4. Thêm cleanup policy cho session/event/log cũ.

## Tiêu chí release hiện tại

- `npm test`: 20/20 pass.
- Plugin và skill validator pass.
- Tất cả PowerShell parse thành công; launcher path có khoảng trắng pass trên PowerShell 5.1.
- `doctor.cmd`: toàn bộ check pass.
- `agy mcp list`: `codex-antigravity-pm` enabled.
- `git diff --check`: pass; không commit database, cache, dependency hoặc secret.
