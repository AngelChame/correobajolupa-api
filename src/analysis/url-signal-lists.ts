/** Listas explícitas, pequeñas y revisables. Nunca se descargan del enlace del correo. */
export const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'cutt.ly']);
export const EXECUTABLE_SUFFIXES = ['.exe', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.js'];
export const RISKY_TLDS = new Set(['zip', 'click', 'top', 'xyz']);
export const LURE_WORDS = /(?:^|[./_-])(?:login|verify|secure|update)(?:[./_-]|$)/i;
export const REDIRECT_PARAMS = new Set(['url', 'redirect', 'redirect_uri', 'next', 'return', 'return_url', 'target', 'dest']);
