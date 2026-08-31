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

// ── Brand images: agency logos and payment-account icons ────────────────
//
// Separate multer instances rather than a branch inside the one above, for
// two reasons that both matter.
//
// Where they land: a logo is chosen while REGISTERING a business, so at the
// moment of upload that business has no id — and the uploader is the super
// admin, whose own business_id is null. The per-tenant folder the main
// storage builds would put every agency's logo in 'tmp' together. These go
// to flat, named folders instead, which is also the honest description: the
// file belongs to the platform's store until a row exists to claim it.
//
// What they accept: PNG and JPEG only. PDFKit — which draws the invoice —
// can embed exactly those two. Accepting WebP here would let someone upload
// an image that looks fine in the browser and then silently fails to render
// on every invoice, which is far worse than being told at upload time.
const BRAND_TYPES = ['image/png', 'image/jpeg'];

/**
 * @param {string} folder   subdirectory of uploadDir to write into
 * @param {string} prefix   file name prefix, so a stray file is identifiable
 * @param {number} maxBytes deliberately small — these are marks on a page,
 *                          not photographs, and every one of them is
 *                          embedded into every invoice the agency prints
 */
const brandUpload = (folder, prefix, maxBytes) =>
  multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(uploadDir, folder);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
        cb(
          null,
          `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`,
        );
      },
    }),
    fileFilter: (req, file, cb) => {
      if (BRAND_TYPES.includes(file.mimetype)) return cb(null, true);
      cb(
        new Error(
          'That image must be a PNG or JPEG. Those are the two formats that can be printed on an invoice.',
        ),
        false,
      );
    },
    limits: { fileSize: maxBytes },
  });

const logoUpload = brandUpload('logos', 'logo', 2 * 1024 * 1024);
// Icons are smaller still: they are drawn at about 26pt square on the page,
// so anything past half a megabyte is detail nobody will ever see, paid for
// on every invoice.
const iconUpload = brandUpload('icons', 'icon', 512 * 1024);

// Exposed so index.js can serve the same directory multer writes to.
upload.uploadDir = uploadDir;
// Exposed as properties so `require('./upload')` keeps returning the same
// multer instance every existing route already uses.
upload.logo = logoUpload;
upload.icon = iconUpload;

module.exports = upload;
