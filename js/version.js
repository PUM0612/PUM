// Số phiên bản PUM iPhone, đi cùng PUM máy tính: cùng số = cùng các thay đổi (người dùng dặn).
// 1.1.1 = PUM máy tính 1.1.1 + Xoá vật thể bằng AI. Người dùng chốt ngày 21/11/2026: giữ số 1.1.1, không lên 1.2.0.
// Tên bộ đệm trong sw.js = phiên bản + dấu vân tay các tệp (tools/phat_hanh.py), nên giữ nguyên số mà sửa tệp thì
// iPhone vẫn tự nhận bản mới.
export const VERSION = '1.1.1';
export const BUILD_DATE = '21/11/2026';
// "Có gì mới" hiện ở menu ☰ › Giới thiệu
export const NOTES = [
  'Xoá vật thể bằng AI (giống PUM máy tính): vật bị xoá hẳn, AI dựng lại phần nền phía sau — không chép mảng ảnh chỗ khác sang. Lần đầu dùng tải mô hình AI ~220 MB (nên dùng Wi-Fi), sau đó chạy cả khi không có mạng. "Thử cách khác" = dựng lại với lượng bối cảnh khác.',
  'Color Editor nâng cao (tab Màu): chấm màu trên ảnh tạo dải màu riêng, chỉnh độ rộng / độ mềm / khoảng bão hoà rồi đổi Sắc độ, Bão hoà, Độ sáng; "Xem vùng chọn" thấy đúng màu đang bị chỉnh.',
  'Chân dung — Xoá nếp nhăn áo làm lại cho thật: nếp gấp nhỏ xoá mạnh, nếp mềm chỉ dịu bớt, giữ khối áo và sợi vải, giữ sắc nét ve áo / đường may.',
  'Chân dung — Tóc con bay ra ngoài xoá sạch hơn: nhận cả sợi tóc mờ và sợi tóc được nắng chiếu sáng, không lem vào chữ / vân phía sau đầu.',
  'Nhận diện được khuôn mặt nhỏ (ảnh đứng toàn thân, ảnh nhóm) cho tab Chân dung.',
  'Đặt lại nhiều kiểu (menu ☰ › Đặt lại…): toàn bộ, màu & tông, khung cắt, retouch, chân dung, layer, tab đang mở, nhiều ảnh.',
  'So sánh trước / sau cùng một ảnh (hoặc với bản sao ảo); mọi ảnh trong So sánh phóng và kéo cùng nhau.',
  'Hạt phim lúc xem vừa màn hình đậm nhạt đúng như ảnh xuất.',
];
