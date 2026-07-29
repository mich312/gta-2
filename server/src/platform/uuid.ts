/**
 * A uuid from whichever host we are running in.
 *
 * `node:crypto`'s `randomUUID` and the browser's `crypto.randomUUID` are the
 * same function with the same output; the only difference is how you reach
 * it. `globalThis.crypto` is a WebCrypto instance in every browser and in
 * Node 19+, and this repo already requires Node 22 for `node:sqlite`, so the
 * global is always there and the import never needs to be.
 *
 * This exists so the economy — which mints a uuid per transaction and is
 * otherwise portable code — does not drag `node:crypto` into a browser
 * bundle. See SHIP.md §3.
 */
export function newUuid(): string {
  return globalThis.crypto.randomUUID();
}
