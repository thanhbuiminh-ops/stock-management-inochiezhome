(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const next = params.get('next') || '/';
  const btn = document.getElementById('google');
  const err = document.getElementById('err');
  // Chỉ cho quay lại đường dẫn nội bộ (server cũng kiểm tra lại)
  if (next.startsWith('/') && !next.startsWith('//')) btn.href = '/api/auth/start?next=' + encodeURIComponent(next);

  const MESSAGES = {
    not_allowed: 'Tài khoản Google này chưa được cấp quyền. Hãy liên hệ người quản trị để được thêm vào danh sách.',
    cancelled: 'Bạn đã huỷ đăng nhập.',
    bad_state: 'Phiên đăng nhập hết hạn hoặc không hợp lệ. Hãy thử lại.',
    email_unverified: 'Email Google này chưa được xác minh.',
    server_misconfigured: 'Server chưa được cấu hình xong (thiếu biến môi trường). Liên hệ người quản trị.',
    google_rejected: 'Google từ chối yêu cầu đăng nhập. Kiểm tra cấu hình OAuth (Client ID/Secret, Redirect URI).',
    google_bad_token: 'Không xác minh được phản hồi từ Google.',
    google_unreachable: 'Không kết nối được tới Google. Thử lại sau.',
  };
  const code = params.get('error');
  if (code) {
    err.textContent = MESSAGES[code] || 'Đăng nhập thất bại.';
    err.hidden = false;
  }
})();
