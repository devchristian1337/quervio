// Shared invalidation signal; importing it does not load Monaco.
let revision = 0;
export function metadataRevision() {
  return revision;
}
export function invalidateCatalog() {
  revision++;
}
