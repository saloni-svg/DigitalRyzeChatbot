// Keep work running after the response has been sent (Vercel waitUntil), or finish it first if unavailable.
export async function inBackground(promise) {
  const safe = Promise.resolve(promise).catch(err => console.error("Background task failed", err));
  try {
    const { waitUntil } = await import("@vercel/functions");
    waitUntil(safe);
  } catch {
    await safe;
  }
}
