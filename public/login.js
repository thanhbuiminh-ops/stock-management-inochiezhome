(() => {
  'use strict';
  const form = document.getElementById('form');
  const err = document.getElementById('err');
  const btn = document.getElementById('submit');

  // Chỉ cho quay lại đường dẫn nội bộ (chống open redirect)
  const params = new URLSearchParams(location.search);
  let next = params.get('next') || '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) next = '/';

  const MESSAGES = {
    invalid_credentials: 'Email hoặc mật khẩu không đúng.',
    locked: 'Sai quá nhiều lần. Thử lại sau ít phút.',
    server_misconfigured: 'Server chưa được cấu hình xong. Liên hệ người quản trị.',
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      });
      if (res.ok) { location.replace(next); return; }
      const data = await res.json().catch(() => ({}));
      err.textContent = MESSAGES[data.error] || 'Đăng nhập thất bại (' + res.status + ').';
      err.hidden = false;
    } catch {
      err.textContent = 'Không kết nối được tới server.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
})();
