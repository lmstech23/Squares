/**
 * Exhaustiveness guard. [R1]
 *
 * Every read of a union — EventStatus above all — routes through a switch whose
 * default calls this. Adding a member to the union then fails to COMPILE at every
 * place that has to make a decision about it, instead of silently inheriting the
 * behaviour of whichever branch happened to be the fallback.
 *
 * This is the entire mechanism that keeps the CANCELLED seam open.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`)
}
