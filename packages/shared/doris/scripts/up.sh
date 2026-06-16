#!/bin/sh

# Load environment variables
[ -f ../../.env ] && source ../../.env

# Check if DORIS_FE_HTTP_URL and DORIS_FE_QUERY_PORT are configured
if [ -z "${DORIS_FE_HTTP_URL}" ] || [ -z "${DORIS_FE_QUERY_PORT}" ]; then
  echo "Info: DORIS_FE_HTTP_URL or DORIS_FE_QUERY_PORT not configured, skipping migration."
  exit 0
fi

# Check if mysql client is installed (Doris uses MySQL protocol)
if ! command -v mysql > /dev/null 2>&1; then
    echo "Error: mysql client is not installed or not in PATH."
    echo "Please install mysql client to run this script."
    exit 1
fi

# Ensure DORIS_DB is set
if [ -z "${DORIS_DB}" ]; then
    export DORIS_DB="langfuse"
fi

# Ensure DORIS_USER is set
if [ -z "${DORIS_USER}" ]; then
    export DORIS_USER="root"
fi

# Parse DORIS_FE_HTTP_URL to extract protocol and host using POSIX-compatible methods.
case "${DORIS_FE_HTTP_URL}" in
    *://*)
        DORIS_HTTP_PROTOCOL=$(echo "${DORIS_FE_HTTP_URL}" | sed 's|^\([a-zA-Z][a-zA-Z0-9+.-]*\)://.*|\1|')
        url_without_protocol=$(echo "${DORIS_FE_HTTP_URL}" | sed 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||')
        ;;
    *)
        DORIS_HTTP_PROTOCOL="http"
        url_without_protocol="${DORIS_FE_HTTP_URL}"
        ;;
esac

# Extract host (everything before the first colon or slash)
DORIS_HOST=$(echo "${url_without_protocol}" | sed 's|[:/].*||')

# Use DORIS_FE_QUERY_PORT for MySQL protocol connections
DORIS_PORT="${DORIS_FE_QUERY_PORT}"

echo "Connecting to Doris at ${DORIS_HTTP_PROTOCOL}://${DORIS_HOST}:${DORIS_PORT} with database ${DORIS_DB}"
echo "Debug: DORIS_USER=${DORIS_USER}, DORIS_PASSWORD=${DORIS_PASSWORD}"

# Build MySQL connection arguments
MYSQL_ARGS="-h${DORIS_HOST} -P${DORIS_PORT} -u${DORIS_USER} --protocol=TCP"
if [ -n "${DORIS_PASSWORD}" ]; then
    MYSQL_ARGS="${MYSQL_ARGS} -p${DORIS_PASSWORD}"
fi

# Create database if it doesn't exist
echo "Creating database ${DORIS_DB} if not exists..."
mysql ${MYSQL_ARGS} -e "CREATE DATABASE IF NOT EXISTS ${DORIS_DB};"

if [ $? -ne 0 ]; then
    echo "Error: Failed to create database ${DORIS_DB}"
    exit 1
fi

# Create migration tracking table if it doesn't exist
echo "Creating migration tracking table..."
mysql ${MYSQL_ARGS} "${DORIS_DB}" << EOF
CREATE TABLE IF NOT EXISTS schema_migrations (
    version varchar(255) NOT NULL,
    applied_at datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=OLAP
DUPLICATE KEY(version)
DISTRIBUTED BY HASH(version) BUCKETS 1
PROPERTIES (
    "replication_allocation" = "tag.location.default: 1"
);
EOF

if [ $? -ne 0 ]; then
    echo "Error: Failed to create schema_migrations table"
    exit 1
fi

# Function to check if migration is already applied
is_migration_applied() {
    local version=$1
    local count=$(mysql ${MYSQL_ARGS} "${DORIS_DB}" -N -e "SELECT COUNT(*) FROM schema_migrations WHERE version = '${version}';")
    [ "$count" -gt 0 ]
}

# Function to mark migration as applied
mark_migration_applied() {
    local version=$1
    mysql ${MYSQL_ARGS} "${DORIS_DB}" -e "INSERT INTO schema_migrations (version) VALUES ('${version}');"
}

get_create_table_stmt() {
    local table_name=$1
    mysql ${MYSQL_ARGS} "${DORIS_DB}" -N -e "SHOW CREATE TABLE ${table_name}\\G"
}

normalize_sql_text() {
    printf '%s' "${1}" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g'
}

normalize_partition_retention() {
    case "${1}" in
        ""|"off"|"OFF"|"Off"|"0")
            echo ""
            ;;
        *[!0-9]*)
            echo "__INVALID__"
            ;;
        *)
            if [ "${1}" -le 0 ]; then
                echo "__INVALID__"
            else
                echo "${1}"
            fi
            ;;
    esac
}

apply_partition_retention() {
    local table_name=$1
    local date_column=$2
    local table_exists
    local desired_retention=$3
    local create_stmt
    local current_retention
    local current_retention_line

    table_exists=$(mysql ${MYSQL_ARGS} "${DORIS_DB}" -N -e "SHOW TABLES LIKE '${table_name}';")
    if [ -z "${table_exists}" ]; then
        echo "Skipping partition.retention_count update for ${table_name}: table does not exist."
        return
    fi

    create_stmt=$(get_create_table_stmt "${table_name}")
    normalize_sql_text "${create_stmt}" | grep -Ei "AUTO PARTITION BY RANGE[[:space:]]*\\(date_trunc\\(\`${date_column}\`,[[:space:]]*'day'\\)\\)" >/dev/null 2>&1
    if [ $? -ne 0 ]; then
        echo "Error: ${table_name} is not day-partitioned on ${date_column}; refusing to set partition.retention_count."
        exit 1
    fi

    current_retention_line=$(echo "${create_stmt}" | grep -o '"partition\.retention_count"[[:space:]]*=[[:space:]]*"[^"]*"' | head -n 1)
    current_retention=$(echo "${current_retention_line}" | sed 's/.*"\([^"]*\)"$/\1/')

    if [ -z "${desired_retention}" ]; then
        echo "Retention disabled for ${table_name}; leaving current partition.retention_count=${current_retention:-<unset>} unchanged."
        return
    fi

    if [ "${current_retention}" = "${desired_retention}" ]; then
        echo "Skipping partition.retention_count update for ${table_name}: already ${desired_retention}."
        return
    fi

    echo "Applying partition.retention_count=${desired_retention} to ${table_name}..."
    mysql ${MYSQL_ARGS} "${DORIS_DB}" -e "ALTER TABLE ${table_name} SET (\"partition.retention_count\" = \"${desired_retention}\");"

    if [ $? -ne 0 ]; then
        echo "Error: Failed to update partition.retention_count for ${table_name}"
        exit 1
    fi
}

# Execute migrations in order
MIGRATION_DIR="doris/migrations"
echo "Executing migrations from ${MIGRATION_DIR}..."

# Get all .up.sql files and sort them
for migration_file in $(ls ${MIGRATION_DIR}/*.up.sql | sort); do
    # Extract version from filename (e.g., 0001_traces.up.sql -> 0001_traces)
    version=$(basename "${migration_file}" .up.sql)

    echo "Processing migration: ${version}"

    # Check if migration is already applied
    if is_migration_applied "${version}"; then
        echo "  Migration ${version} already applied, skipping..."
        continue
    fi

    echo "  Applying migration ${version}..."

    # Execute the migration
    mysql ${MYSQL_ARGS} "${DORIS_DB}" < "${migration_file}"
    migration_status=$?

    if [ ${migration_status} -eq 0 ]; then
        # Mark migration as applied
        mark_migration_applied "${version}"
        echo "  Migration ${version} applied successfully"
    else
        echo "  Error: Failed to apply migration ${version}"
        exit 1
    fi
done

if [ -n "${LITEFUSE_DORIS_PARTITION_RETENTION_DAYS}" ]; then
    normalized_retention=$(normalize_partition_retention "${LITEFUSE_DORIS_PARTITION_RETENTION_DAYS}")

    if [ "${normalized_retention}" = "__INVALID__" ]; then
        echo "Error: LITEFUSE_DORIS_PARTITION_RETENTION_DAYS must be a positive integer, 0, or off."
        exit 1
    fi

    apply_partition_retention "events_full" "start_time_date" "${normalized_retention}"
fi

echo "All migrations completed successfully!"
