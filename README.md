# TAMS — Travel Agency Management System

A complete multi-tenant system for Mogadishu travel agencies. Upload any airline ticket (PDF or screenshot), Claude Vision AI extracts the data automatically, your agent reviews and confirms.

---

## Architecture

```
MVC pattern — Express backend, React frontend, PostgreSQL database

/tams
  /server
    /config          → DB pool, schema.sql
    /controllers     → authController, ticketController, customerController, reportController, userController
    /routes          → All API routes in routes/index.js
    /middlewares     → auth.js (JWT + RBAC), upload.js (Multer), errorHandler.js
    /services        → aiExtraction.js (Claude Vision), reportService.js (PDF + Excel)
    /uploads         → Uploaded ticket files (scoped per business_id)
    /utils           → response.js (standardized API format)
    index.js         → Express app entry point

  /client/src
    /components
      /ui            → Button, Input, Select, Card, Badge, Modal, Pagination, etc.
      /layout        → Layout.jsx (sidebar + dark mode)
      /tickets       → TicketForm.jsx (AI upload + manual form)
    /pages           → LoginPage, RegisterPage, DashboardPage, TicketsPage,
                       CustomersPage, ReportsPage, UsersPage
    /context         → AuthContext.jsx, ThemeContext.jsx
    /services        → api.js (Axios client with JWT interceptors)
    App.jsx          → Router + protected routes
```

---

## Tech Stack

| Layer    | Technology |
|----------|-----------|
| Frontend | React 18 + Tailwind CSS + Recharts |
| Backend  | Node.js + Express.js |
| Database | PostgreSQL 14+ |
| AI       | Claude claude-sonnet-4-6 (Vision — image + PDF) |
| Auth     | JWT + role-based access control |
| Upload   | Multer (local disk, per-tenant folders) |
| Reports  | PDFKit (PDF) + ExcelJS (Excel) |

---

## Roles

| Role        | Permissions |
|-------------|-------------|
| super_admin | All agencies, all data |
| admin       | Full access within own agency |
| agent       | Create/manage tickets, view customers |
| accountant  | Read-only: dashboard, reports, export |

---

## Quick Start

### 1. PostgreSQL

```bash
createdb tams_db
psql tams_db < server/config/schema.sql
```

### 2. Backend

```bash
cd server
cp .env.example .env
# Fill in DB credentials and ANTHROPIC_API_KEY
npm install
npm run dev
```

Server starts on **http://localhost:5000**

### 3. Frontend

```bash
cd client
npm install
npm start
```

App opens at **http://localhost:3000**

---

## Environment Variables (server/.env)

```env
PORT=5000
NODE_ENV=development

DB_HOST=localhost
DB_PORT=5432
DB_NAME=tams_db
DB_USER=postgres
DB_PASSWORD=your_password

JWT_SECRET=change_this_to_a_long_random_string
JWT_EXPIRES_IN=7d

ANTHROPIC_API_KEY=sk-ant-...

UPLOAD_PATH=./uploads
MAX_FILE_SIZE=10485760   # 10 MB

CLIENT_URL=http://localhost:3000
```

---

## API Reference

All responses follow this format:
```json
{
  "success": true,
  "message": "...",
  "data": {},
  "meta": { "page": 1, "limit": 20, "total": 150, "totalPages": 8 }
}
```

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/register | Create agency + admin user |
| POST | /api/auth/login | Login → JWT |
| GET  | /api/auth/me | Current user profile |

### Tickets
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/tickets/extract | Upload PDF/image → AI extracts JSON |
| GET  | /api/tickets | List with search, filter, pagination |
| POST | /api/tickets | Create ticket |
| GET  | /api/tickets/:id | Get ticket |
| PUT  | /api/tickets/:id | Update ticket |
| DELETE | /api/tickets/:id | Delete ticket |

#### AI Extraction (POST /api/tickets/extract)
Upload multipart form with field `ticket_file`. Returns:
```json
{
  "extracted": {
    "passenger_name": "Hassan Ali",
    "from_city": "Mogadishu",
    "to_city": "Dubai",
    "flight_date": "2025-03-15",
    "airline_name": "Turkish Airlines",
    "ticket_reference": "PNR123",
    "ticket_type": "INTERNATIONAL",
    "passport_number": "A12345678",
    ...
  },
  "source_file_url": "filename.pdf"
}
```

### Customers
| Method | Path | Description |
|--------|------|-------------|
| GET  | /api/customers | List + search |
| GET  | /api/customers/:id | Profile + full ticket history |
| PUT  | /api/customers/:id | Update profile |
| DELETE | /api/customers/:id | Delete (admin only) |

### Reports
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/reports/dashboard | Stats, chart, agent perf, top routes |
| GET | /api/reports/tickets | Filtered ticket list for reports |
| GET | /api/reports/export/pdf | Download PDF report |
| GET | /api/reports/export/excel | Download Excel report |

All report endpoints accept: `from_date`, `to_date`, `ticket_type`, `agent_id`

### Users (admin only)
| Method | Path | Description |
|--------|------|-------------|
| GET  | /api/users | List team members |
| POST | /api/users | Create user |
| PUT  | /api/users/:id | Update user |
| DELETE | /api/users/:id | Delete user |

---

## Database Schema

```
businesses      → id, name, email, phone, status
users           → id, business_id, name, email, password_hash, role
customers       → id, business_id, name, phone, passport_number, nationality, ...
tickets         → id, business_id, customer_id, created_by, ticket_type,
                  passenger_name, from_city, to_city, flight_date, airline_name,
                  cost_price, selling_price, revenue (GENERATED),
                  passport_number, visa_type, ...  (international fields nullable)
```

Key design decisions:
- Every table has `business_id` for multi-tenancy — queries always scoped
- `revenue` is a generated column: `selling_price - cost_price`
- International-only fields are nullable with a CHECK constraint
- All primary keys are UUIDs
- Indexes on: business_id, flight_date, status, ticket_type, passenger_name

---

## AI Extraction Flow

1. Agent uploads PDF or image via the ticket form upload zone
2. Server saves the file to `uploads/<business_id>/` via Multer
3. File is read as base64 and sent to Claude claude-sonnet-4-6 with a structured prompt
4. Claude returns JSON with all extractable fields (nulls for missing)
5. Form fields are populated client-side — agent reviews and adjusts prices
6. Agent clicks "Create Ticket" to save

Supported file types: JPEG, PNG, WebP, PDF (up to 10MB)

---

## Features

- ✅ Multi-tenant isolation (business_id on every query)
- ✅ JWT auth with 4 roles
- ✅ AI ticket extraction from PDF + images
- ✅ Local and International ticket types
- ✅ Auto customer profile creation on first booking
- ✅ Dashboard with live charts (30-day trend, agent performance, top routes)
- ✅ Revenue = selling price − cost price (auto-computed)
- ✅ Export reports to PDF and Excel
- ✅ Dark / light mode
- ✅ Responsive (desktop + tablet + mobile)
- ✅ Search, filter, pagination on all list pages
- ✅ Rate limiting on auth endpoints
- ✅ Standardized API responses

---

## Production Deployment

1. Set `NODE_ENV=production` in server `.env`
2. Build the frontend: `cd client && npm run build`
3. Serve the `build/` folder from Express (or a CDN/nginx)
4. Use a process manager like PM2: `pm2 start server/index.js --name tams`
5. Set up PostgreSQL with a dedicated user and strong password
6. Use environment secrets manager (not a plain .env file) in production
7. Consider object storage (S3-compatible) for uploaded files at scale

---

## Folder Structure Summary

```
tams/
├── server/
│   ├── config/
│   │   ├── db.js            ← PostgreSQL pool
│   │   └── schema.sql       ← Full DB schema
│   ├── controllers/
│   │   ├── authController.js
│   │   ├── ticketController.js
│   │   ├── customerController.js
│   │   ├── reportController.js
│   │   └── userController.js
│   ├── middlewares/
│   │   ├── auth.js          ← JWT + RBAC
│   │   ├── upload.js        ← Multer config
│   │   └── errorHandler.js
│   ├── routes/
│   │   └── index.js
│   ├── services/
│   │   ├── aiExtraction.js  ← Claude Vision
│   │   └── reportService.js ← PDF + Excel
│   ├── utils/
│   │   └── response.js
│   ├── .env.example
│   ├── package.json
│   └── index.js             ← Express entry
│
└── client/
    ├── public/
    │   └── index.html
    ├── src/
    │   ├── components/
    │   │   ├── ui/index.jsx      ← All reusable UI
    │   │   ├── layout/Layout.jsx ← Sidebar
    │   │   └── tickets/TicketForm.jsx
    │   ├── context/
    │   │   ├── AuthContext.jsx
    │   │   └── ThemeContext.jsx
    │   ├── pages/
    │   │   ├── LoginPage.jsx
    │   │   ├── RegisterPage.jsx
    │   │   ├── DashboardPage.jsx
    │   │   ├── TicketsPage.jsx
    │   │   ├── CustomersPage.jsx
    │   │   ├── ReportsPage.jsx
    │   │   └── UsersPage.jsx
    │   ├── services/api.js
    │   ├── App.jsx
    │   └── index.js
    ├── tailwind.config.js
    └── package.json
```
