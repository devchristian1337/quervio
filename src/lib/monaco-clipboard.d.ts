// Monaco's Paste command (src/lib/monaco.ts), deep-imported without types.
declare module "monaco-esm/editor/contrib/clipboard/browser/clipboard.js" {
  type Implementation = (accessor: unknown, args: unknown) => boolean | Promise<unknown>;
  export const PasteAction:
    | { addImplementation(priority: number, name: string, implementation: Implementation): { dispose(): void } }
    | undefined;
}
