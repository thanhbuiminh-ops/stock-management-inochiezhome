import { getStore } from '@netlify/blobs';

// Store dùng chung cho snapshot tồn kho, trạng thái sync và bộ đếm đăng nhập sai.
// globalThis.__TEST_STORE__ chỉ dùng trong test.
export function stockStore() {
  return globalThis.__TEST_STORE__ ?? getStore({ name: 'stock', consistency: 'strong' });
}
