const response = require('../utils/response');

const errorHandler = (err, req, res, next) => {
  console.error('Error:', err.message);
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack);
  }

  // PostgreSQL errors
  if (err.code === '23505') {
    return response.error(res, 'A record with this value already exists', 409);
  }
  if (err.code === '23503') {
    return response.error(res, 'Referenced record not found', 400);
  }
  if (err.code === '22P02') {
    return response.error(res, 'Invalid ID format', 400);
  }
  // 23514 = check constraint violated. Postgres reports the constraint's
  // name, which means nothing to the person who just clicked Save, so each
  // one gets a sentence saying what to do about it.
  if (err.code === '23514') {
    const CONSTRAINT_MESSAGES = {
      chk_international_fields:
        'International tickets need a passport number. Add it under Travel documents.',
    };
    return response.error(
      res,
      CONSTRAINT_MESSAGES[err.constraint] ||
        'Some required information is missing or inconsistent. Please check the form.',
      400,
    );
  }
  // Missing table / column almost always means a migration hasn't been run.
  if (err.code === '42P01' || err.code === '42703') {
    console.error(
      '[TAMS] Database is missing something this code expects.\n' +
        '       Run the migrations from the server folder:\n' +
        '         psql -U postgres -d tams_db -f config/migration_v4.sql\n' +
        '         psql -U postgres -d tams_db -f config/migration_v5.sql',
    );
    return response.error(
      res,
      'This feature needs a database update. Ask your administrator to run the pending migrations (migration_v4.sql and migration_v5.sql).',
      503,
    );
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return response.error(res, 'File too large. Max 10MB allowed.', 413);
  }

  const statusCode = err.statusCode || 500;

  // An unexpected 500 carries a message written for developers — file paths,
  // SQL fragments, library internals. In production that is free
  // reconnaissance for anyone probing the system, so only errors we raised
  // deliberately are allowed to speak for themselves. The full detail still
  // goes to the log above, where it is actually useful.
  const isDeliberate = statusCode < 500 || err.expose === true;
  const message =
    isDeliberate && err.message
      ? err.message
      : process.env.NODE_ENV === 'production'
        ? 'Something went wrong. Please try again.'
        : err.message || 'Internal server error';

  return response.error(res, message, statusCode);
};

module.exports = errorHandler;
