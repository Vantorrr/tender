export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackgroundJobs } = await import("@/server/scheduler");
    startBackgroundJobs();
  }
}
