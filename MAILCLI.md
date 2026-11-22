# Webmail CLI

`mailcli.py` dùng Python 3 và thư viện chuẩn. Tạo file `~/.webmail_api_key` chứa API key; giữ file này ở máy cá nhân và không đưa vào repository. Có thể chọn file khác bằng `--key-file` hoặc máy chủ khác bằng `--base-url`.

```sh
chmod +x mailcli.py
./mailcli.py status
./mailcli.py inbox --limit 20
./mailcli.py sent
./mailcli.py read 12345678
./mailcli.py send --to person@example.com --subject 'Xin chào' --text 'Nội dung thư'
./mailcli.py send --to person@example.com --cc copy@example.com --from alias@aistockvn.com --subject 'Thông tin' --text 'Nội dung'
./mailcli.py search hóa đơn
./mailcli.py unread
```

`read` nhận ID đầy đủ hoặc 8 ký tự đầu nếu khớp duy nhất. `inbox`, `sent` và `search` in một dòng cho mỗi thư. `unread` in tổng số thư chưa đọc trong inbox và tối đa 20 dòng thư. `status` xác minh key bằng cách gọi API inbox.
