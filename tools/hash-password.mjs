#!/usr/bin/env node
// Dùng:  npm run hash-password -- ten@email.com
// Nhập mật khẩu khi được hỏi (không hiện trên màn hình, không lưu vào lịch sử shell).
// In ra một cặp  "email": "hash"  để dán vào biến môi trường USERS_JSON.
import { createInterface } from 'node:readline';
import { hashPassword } from '../lib/password.mjs';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email.includes('@')) {
  console.error('Cách dùng: npm run hash-password -- ten@email.com');
  process.exit(1);
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    }
    rl.question(prompt, (answer) => { rl.close(); if (process.stdin.isTTY) process.stdout.write('\n'); resolve(answer); });
  });
}

const pw = await askHidden('Mật khẩu (>= 12 ký tự): ');
if (pw.length < 12) { console.error('Mật khẩu quá ngắn.'); process.exit(1); }
const again = await askHidden('Nhập lại: ');
if (pw !== again) { console.error('Hai lần nhập không khớp.'); process.exit(1); }

const hash = await hashPassword(pw);
console.log('\nDán dòng sau vào USERS_JSON (nhiều người thì ngăn cách bằng dấu phẩy, bọc trong { }):\n');
console.log(`${JSON.stringify(email)}: ${JSON.stringify(hash)}`);
