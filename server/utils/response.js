/**
 * Standardized API response format
 * { success, message, data, meta }
 */

const success = (res, data = null, message = 'Success', statusCode = 200, meta = null) => {
  const response = { success: true, message };
  if (data !== null) response.data = data;
  if (meta !== null) response.meta = meta;
  return res.status(statusCode).json(response);
};

const created = (res, data = null, message = 'Created successfully') => {
  return success(res, data, message, 201);
};

const error = (res, message = 'An error occurred', statusCode = 500, errors = null) => {
  const response = { success: false, message };
  if (errors) response.errors = errors;
  return res.status(statusCode).json(response);
};

const notFound = (res, message = 'Resource not found') => {
  return error(res, message, 404);
};

/**
 * `code` is a stable machine-readable reason the client can branch on.
 * The message is for people and may be reworded freely; the code is not.
 * Used to tell "your session ended because you signed in elsewhere" apart
 * from "your session simply expired".
 */
const unauthorized = (res, message = 'Unauthorized', code = null) => {
  const body = { success: false, message };
  if (code) body.code = code;
  return res.status(401).json(body);
};

const forbidden = (res, message = 'Access denied') => {
  return error(res, message, 403);
};

const validationError = (res, errors) => {
  return error(res, 'Validation failed', 422, errors);
};

const paginated = (res, data, page, limit, total, message = 'Success') => {
  return success(res, data, message, 200, {
    page: parseInt(page),
    limit: parseInt(limit),
    total,
    totalPages: Math.ceil(total / limit),
  });
};

module.exports = { success, created, error, notFound, unauthorized, forbidden, validationError, paginated };
