export default async function teardown() {
  const { stopSharedPostgresPool } = await import(
    "@langfuse/shared/src/server"
  );
  await stopSharedPostgresPool();
}
