const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Absolute, so it means the same thing however the process was started.
// index.js serves this exact directory at /uploads — the two must agree, or
// files upload successfully and then 404 when the browser asks for them.
const uploadDir = path.resolve(
  process.env.UPLOAD_PATH || path.join(__dirname, '..', 'uploads'),
);
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadDir, req.user?.business_id || 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, WebP, and PDF files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760') },
});

// Exposed so index.js can serve the same directory multer writes to.
upload.uploadDir = uploadDir;

module.exports = upload;
