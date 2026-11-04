// Presentation only; native code makes all security and executable decisions.
export const isLinux = typeof navigator !== "undefined" && /Linux/i.test(navigator.platform);
