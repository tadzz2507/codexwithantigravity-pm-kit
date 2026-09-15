# Tối ưu Codex -> Antigravity PM

## Đã xử lý

- Chặn dependency trùng, dependency khác project và dependency cycle khi tạo/cập nhật task.
- Xóa `claimed_by` và heartbeat khi task chuyển sang `blocked`.
- Loại build output, dependency cài local, database và log khỏi Git.

## P0 - trước production

1. Thêm test cạnh tranh claim/requeue bằng hai store mở chung SQLite.
2. Làm transaction cho các thao tác đổi trạng thái kèm event; tránh trạng thái đổi nhưng audit event lỗi.
3. Thêm migration version table thay cho bắt lỗi chuỗi `duplicate column name`.
4. Sửa runner PID thành state có `Pid` + `StartTimeUtc`; không kill PID đã bị tái sử dụng.

## P1 - độ tin cậy

1. Thêm timeout cho `powershell.exe`, `agy`, `codex` và backoff khi worker lỗi liên tiếp.
2. Ghi `lastError`, số lần retry và trạng thái runner vào database.
3. Dọn session stale theo policy; phân biệt `ended`, `stale`, `busy` rõ hơn.
4. Kiểm tra repository path đã tồn tại trước khi tạo project trong `project_run`.

## P2 - chức năng

1. Thêm pagination cho task/event/session list.
2. Thêm dry-run/status JSON cho installer và runner scripts.
3. Thêm kiểm tra Git diff thực tế trước khi chấp nhận changed files.
4. Thêm CI Windows: build, test server, test installer/doctor ở chế độ mock.

## Tiêu chí hoàn thành

- `npm test` pass.
- Không có dependency cycle xuyên qua `task_update_spec`.
- Task blocked không còn worker claim cũ.
- Repository sạch build artifact, không commit secret/database/local dependency.
