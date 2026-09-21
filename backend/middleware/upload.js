import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROMOS_DIR = path.join(__dirname, '..', 'uploads', 'promos');
const CAFES_DIR  = path.join(__dirname, '..', 'uploads', 'cafes');

for (const dir of [PROMOS_DIR, CAFES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('Only image files are allowed (jpg, png, webp, gif)'), false);
};

// ── Promo image uploads ─────────────────────────────────────────
const promoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PROMOS_DIR),
  filename: (req, file, cb) => {
    const unique = `promo_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname).toLowerCase()}`);
  }
});

export const uploadPromo = multer({
  storage: promoStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
}).single('image');

// ── Cafe logo / profile picture uploads ─────────────────────────
const cafeStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CAFES_DIR),
  filename: (req, file, cb) => {
    const unique = `cafe_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}${path.extname(file.originalname).toLowerCase()}`);
  }
});

export const uploadCafeLogo = multer({
  storage: cafeStorage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
}).single('image');

export { PROMOS_DIR, CAFES_DIR };
