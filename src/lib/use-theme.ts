import { useEffect, useState } from "react";
import { findTheme, type Theme } from "@/lib/themes";
import { useSettings } from "@/stores/settings";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Whether Windows is in dark mode, kept up to date. */
export function useSystemDark() {
  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return dark;
}

/** The theme in use: the chosen one, or Light/Dark following Windows. */
export function useTheme(): Theme {
  const id = useSettings((s) => s.settings.appearance.theme);
  const systemDark = useSystemDark();
  return findTheme(id, systemDark);
}
