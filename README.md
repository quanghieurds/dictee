# Dictée – luyện chép chính tả tiếng Pháp

## Mở phần mềm
Nhấp đúp `Mo-Dictee.bat` (mở bằng Microsoft Edge). Có thể mở `index.html` bằng Chrome, nhưng Edge có giọng Pháp tự nhiên hơn (Denise, Henri...).
Không cần cài đặt hay mạng riêng; giọng "Online (Natural)" của Edge cần có Internet.

Giao diện có hai ngôn ngữ: bấm **VI / FR** ở góc trên cột trái. Giao diện tự chuyển nền tối theo cài đặt của Windows.

## Dùng trên điện thoại / iPad
Mở link GitHub Pages của app rồi cài như app thật:
- **iPhone / iPad**: mở bằng Safari → nút Chia sẻ → **Thêm vào Màn hình chính**.
- **Android**: mở bằng Chrome → menu ⋮ → **Cài đặt ứng dụng** (hoặc Thêm vào màn hình chính).

Sau lần mở đầu, app chạy được cả khi không có mạng. Mỗi máy giữ bài và tiến độ riêng: chuyển bằng **Sao lưu** (máy cũ) → **Khôi phục** (máy mới). Bản sao lưu có kèm file âm thanh. Nên nhận dạng file mp3 trên máy tính, điện thoại thường không đủ bộ nhớ.

## Cách dùng
1. **+ Thêm bài** → đặt tên, dán đoạn văn tiếng Pháp. Mở "Máy sẽ tách thành N câu" để xem cách tách. Muốn tách khác thì xuống dòng ở chỗ cần tách.
2. Chọn bài ở cột trái, chọn chế độ:
   - **Đọc từng câu**: câu được đọc lặp lại, nghỉ theo thanh "Nghỉ", đến khi chép đúng (Enter để kiểm tra) mới sang câu sau.
   - **Đọc cả bài**: đọc lần lượt cả bài, chép xong bấm Kiểm tra (Ctrl+Enter).
3. Thanh **Tốc độ** chỉnh tốc độ đọc, **Giọng** chọn giọng đọc.
4. Bí quá thì:
   - **💡 Gợi ý**: mỗi lần mở thêm 1 từ (ưu tiên từ đang sai), từ chưa mở hiện thành `____`.
   - **Xem đáp án**: hiện cả câu; chép lại rồi Enter để qua câu tiếp.
   - **⏭ Bỏ qua câu**: qua luôn, không cần chép.
   Câu dùng gợi ý / đáp án / bỏ qua được ghi nhãn trong danh sách "Đã chép".

## Bài từ file âm thanh (mp3)
1. **+ Thêm bài** → **🎵 Nhận dạng từ file âm thanh…** → chọn file (mp3, m4a, wav, ogg…).
2. Máy tự nghe và viết ra văn bản, mỗi câu một dòng. Tên bài lấy theo tên file nếu chưa đặt.
3. **Đọc lại văn bản và sửa chỗ sai trước khi Lưu**, vì đây sẽ là đáp án. Máy hay sai ở số (`8` → `huit`), tên riêng và từ hiếm. Sửa chữ hoặc tách/gộp câu (xuống dòng) đều được, máy vẫn tự khớp lại đoạn âm thanh của từng câu.
4. Khi luyện, bài có nhãn 🎵 sẽ phát **giọng gốc trong file**, từng câu một (lặp lại như bài thường). Thanh Tốc độ vẫn dùng được.

Ghi chú:
- Bộ nhận dạng (Whisper) chạy ngay trên máy, file không gửi đi đâu. Lần đầu cần Internet để tải bộ nhận dạng (~250 MB, loại "Nhanh" ~80 MB), sau đó trình duyệt giữ lại.
- Máy cắt file ở các chỗ nghỉ rồi nghe từng đoạn (để không bỏ sót lời sau tiêu đề như "Activité 3-2"), mất khoảng 1–2 phút cho mỗi phút âm thanh. Loại "Nhanh" nhanh hơn nhưng nghe sai nhiều hơn. Trong lúc chờ có thể bấm **Dừng**.
- Các dòng tiêu đề mà file đề thi hay đọc ("Activité 8", "Exercice 1", "Compréhension de l'oral", "DELF blanc n°2", số thứ tự đứng riêng...) được tự bỏ. Còn sót tiêu đề nào thì xóa tay dòng đó.
- File âm thanh lưu trong trình duyệt trên máy này. **Sao lưu** chỉ lưu văn bản, không kèm file âm thanh: khôi phục ở máy khác thì bài đó đọc bằng giọng máy.

## Bài mẫu có sẵn (A1–B2)
Thư viện có sẵn 80 bài viết mới, 20 bài cho mỗi trình độ A1, A2, B1, B2, mỗi bài 10–12 câu và trên 100 từ. Chủ đề, ngữ pháp và độ dài được soạn theo khung trình độ của kỳ thi DELF (không phải đề thi chính thức).
Nội dung nằm trong `lessons-builtin.js`. Bấm tên nhóm để mở hoặc đóng. Xóa bài mẫu thì có thể lấy lại bằng nút "Hiện lại bài mẫu đã xóa" ở cuối cột trái.

## Quy tắc chấm
- Bỏ qua dấu trên chữ: `ecole` = `école`, `soeur` = `sœur`.
- Bắt buộc đúng: chữ cái, gạch nối (`peut-être`), viết hoa, dấu `.` `?` `!` (`...` = `…`).
- Bỏ qua: dấu phẩy, `;` `:` `« »` và khoảng trắng trước dấu câu.
- Chỗ sai chỉ được đánh dấu, không hiện đáp án. Gạch sóng: sai chính tả, gạch chấm: sai viết hoa, gạch ngang: thừa, ô trống: thiếu.

## Phím tắt
Enter: kiểm tra (từng câu) · Ctrl+Enter: kiểm tra (cả bài) · Ctrl+Space: đọc lại ngay · Esc: dừng/tiếp · Ctrl+I: gợi ý · Ctrl+→: bỏ qua câu

## Dữ liệu
Bài và tiến độ lưu trong trình duyệt trên máy này. Dùng **Sao lưu** / **Khôi phục** (cuối cột trái) để chuyển thư viện sang máy hoặc trình duyệt khác.
Tắt bộ gõ tiếng Việt (Unikey/EVKey) khi chép, vì Telex có thể biến `dd` thành `đ`.

## Test
`node --test tests/core.test.js`
