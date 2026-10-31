import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

// Supports both:
//   DATABASE_URL  → single connection string (Render, Supabase, Railway)
//   Individual    → DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (local)
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    })
  : new Pool({ /* your local settings unchanged */ });

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});

export default pool;