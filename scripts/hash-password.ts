import argon2 from "argon2";

const password = process.argv[2];
if (!password || password.length < 12) {
  throw new Error("Usage: npm run password:hash -- 'a-password-with-at-least-12-characters'");
}

process.stdout.write(`${await argon2.hash(password, { type: argon2.argon2id })}\n`);

