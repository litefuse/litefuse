// @ts-nocheck
export class ThemeUtils {
  darkMode = false;
  constructor() {
    this.darkMode =
      typeof window !== "undefined" && localStorage.getItem("theme") === "dark";
  }
  getTheme() {
    return typeof window !== "undefined" && localStorage.getItem("theme");
  }
  setTheme(theme: "dark" | "light") {
    if (typeof window !== "undefined") {
      localStorage.setItem("theme", theme);
    }
  }
  switchTheme() {
    if (typeof window !== "undefined") {
      this.getTheme() === "dark"
        ? localStorage.setItem("theme", "light")
        : localStorage.setItem("theme", "dark");
    }
  }
}

export const themeUtils = new ThemeUtils();
