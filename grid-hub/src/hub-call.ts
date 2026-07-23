/** Map hub/binding failures to a generic message (K3 wave 10 RPC parity, wave 20 binding). */
export async function hubCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new Error("grid request denied");
  }
}
