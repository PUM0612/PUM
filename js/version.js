// Số phiên bản PUM iPhone, đi cùng PUM máy tính: cùng số = cùng các thay đổi (người dùng dặn).
// 1.1.1 = PUM máy tính 1.1.1 + Xoá vật thể bằng AI. Người dùng chốt ngày 21/11/2026: giữ số 1.1.1, không lên 1.2.0.
// 1.1.2 (24/11/2026) = các thay đổi của PUM máy tính 1.1.2, TRỪ (người dùng chọn "đăng phần đã có"): giải mã RAW dải rộng
// (lấy lại vùng sáng cháy), xuất Display P3, xoá vật lấy nền thật từ ảnh khác, AI RORem trên card đồ hoạ.
// Tên bộ đệm trong sw.js = phiên bản + dấu vân tay các tệp (tools/phat_hanh.py), nên giữ nguyên số mà sửa tệp thì
// iPhone vẫn tự nhận bản mới.
export const VERSION = '1.1.2';
export const BUILD_DATE = '24/11/2026';
// "Có gì mới" hiện ở menu ☰ › Giới thiệu
export const NOTES = [
  'Tự động chỉnh ảnh như "Bảng điều khiển Capture One": cân màu theo màu da và màu trắng, kéo sáng theo da mặt, vùng sáng nén mềm kiểu phim; ảnh ISO từ 1600 tự khử nhiễu.',
  'Style mới "Gu Capture One (Cơ bản)": màu, độ đậm, vùng tối đen sâu giống Capture One — dùng sau Tự động.',
  'Màu có chiều sâu: 8 dải màu tính theo cảm nhận (đổi màu không loang), thanh mới "Độ sâu màu" và "Đỏ đầm (phim)" (tab Cơ bản / Màu), kênh Luma trong Curve (nâng sáng tối mà da, vải không bạc màu). Ảnh đã chỉnh ở bản trước giữ y như cũ.',
  'Thanh Vùng sáng kéo âm giờ là "vai phim": chỉ nén vùng sáng, giữ màu đậm (vải đỏ, hoa) không bệt.',
  'Chân dung: xoá mụn không còn để chấm xám sát chân tóc, không xoá nhầm gọng kính / mép bóng; Đều màu da san màu là chính nên mặt không bệt.',
  'Xoá vật thể: hạt / vân ở chỗ xoá khớp ảnh hơn; "Thử cách khác" còn 3 cách lấp.',
  'Chưa có trên iPhone (có ở PUM máy tính 1.1.2): lấy lại vùng sáng cháy của ảnh RAW, xuất Display P3, lấy nền thật từ ảnh khác khi xoá vật.',
];
