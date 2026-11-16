-- The email address is the account key: SCIM's `userName` lookups, credentials
-- sign-in, signup and member management all lower-case their input, but the unique
-- index on `users.email` compared case-sensitively. A stored mixed-case address was
-- therefore unreachable through every one of those lookups, and creating the same
-- address in lower case produced a second account for the same person instead of a
-- conflict.
--
-- Lower-case the rows that are not lower-case yet. This directory's migration was
-- written after verifying that no two rows collide when lower-cased
-- (`group by lower(email) having count(*) > 1` returned nothing); an installation
-- with such a collision has to resolve it before applying this migration.
UPDATE "users"
SET "email" = lower("email")
WHERE "email" IS NOT NULL AND "email" <> lower("email");

-- A second, functional unique index rather than replacing "users_email_key": the
-- column index is what the Prisma schema declares (@unique on email), so keeping it
-- avoids schema drift, while this one enforces the case-insensitive invariant that the
-- application already assumes.
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));
