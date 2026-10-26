// Poor Man's T-SQL Formatter (Bridge.NET) reads Node's `global` when it is
// loaded as CommonJS, which is how Vite bundles it. Imported before it.
const scope = globalThis as { global?: typeof globalThis };
scope.global ??= globalThis;
