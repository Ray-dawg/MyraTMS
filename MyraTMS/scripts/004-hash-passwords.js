import bcrypt from "bcryptjs";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const users = [
  { email: "admin@myra.com", password: "password123" },
  { email: "ops@myra.com", password: "password123" },
];

for (const u of users) {
  const hash = await bcrypt.hash(u.password, 12);
  await sql`UPDATE users SET password_hash = ${hash} WHERE email = ${u.email}`;
  console.log(`Updated password hash for ${u.email}`);
}

console.log("All passwords hashed successfully");
