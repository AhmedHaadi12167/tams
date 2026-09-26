const response = require("../utils/response");

const errorHandler = (err, req, res, next) => {
  console.error("Error:", err.message);
  if (process.env.NODE_ENV === "development") {
    console.error(err.stack);
  }

  // PostgreSQL errors
  if (err.code === "23505") {
    return response.error(res, "A record with this value already exists", 409);
  }
  if (err.code === "23503") {
    return response.error(res, "Referenced record not found", 400);
  }
  if (err.code === "22P02") {
    return response.error(res, "Invalid ID format", 400);
  }
  // 23514 = check constraint violated. Postgres reports the constraint's
  // name, which means nothing to the person who just clicked Save, so each
  // one gets a sentence saying what to do about it.
  if (err.code === "23514") {
    const CONSTRAINT_MESSAGES = {
      chk_account_balance_nonnegative:
        "Insufficient account balance. This transaction would make the account balance negative.",
    };
    return response.error(
      res,
      CONSTRAINT_MESSAGES[err.constraint] ||
        "Some required information is missing or inconsistent. Please check the form.",
      400,
    );
  }
  // Missing table / column almost always means a migration hasn't been run.
  if (err.code === "42P01" || err.code === "42703") {
    const missingObject = `${err.message || ""} ${err.table || ""}`;
    const migrationHints = [
      [/opening_balance_(?:items|payments)/i, "migration_v24.sql"],
      [/ticket_deletion_audit/i, "migration_v25.sql"],
      [/opening_balance_deletion_audit/i, "migration_v26.sql"],
      [/airline_aliases/i, "migration_v6.sql"],
      [/\bairlines\b|airline_match_key/i, "migration_v5.sql"],
      [/\bexpenses\b|expense_category/i, "migration_v4.sql"],
    ];
    const hint = migrationHints.find(([pattern]) =>
      pattern.test(missingObject),
    );
    const message = hint
      ? `This database is missing a schema object required by this feature. Apply ${hint[1]} and confirm it completes without ERROR.`
      : "This database is missing a schema object required by this feature. Apply all migrations pending for this database version and confirm each completes without ERROR.";

    console.error(
      `[TAMS] Database schema is incomplete: ${err.message || "missing relation or column"}` +
        (hint ? ` Suggested migration: ${hint[1]}` : ""),
    );
    return response.error(res, message, 503);
  }
  if (err.code === "42883" && /airline_match_key/i.test(err.message || "")) {
    return response.error(
      res,
      "Airline matching is not installed in the database. Apply migration_v5.sql and confirm it completes without ERROR.",
      503,
    );
  }

  // Multer errors
  if (err.code === "LIMIT_FILE_SIZE") {
    return response.error(res, "File too large. Max 10MB allowed.", 413);
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
      : process.env.NODE_ENV === "production"
        ? "Something went wrong. Please try again."
        : err.message || "Internal server error";

  return response.error(res, message, statusCode);
};

module.exports = errorHandler;
