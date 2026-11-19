import {
  matchLocaleTag,
  parseEnabledLocales,
  pickFromAcceptLanguage,
  readLocaleCookie,
  resolveLocale,
  serializeLocaleCookie,
} from "@/src/features/i18n/config";

describe("i18n config", () => {
  describe("matchLocaleTag", () => {
    it("matches exact and region-less tags case-insensitively", () => {
      expect(matchLocaleTag("en")).toBe("en");
      expect(matchLocaleTag("en-US")).toBe("en");
      expect(matchLocaleTag("EN-gb")).toBe("en");
      expect(matchLocaleTag("zh-cn")).toBe("zh-CN");
      expect(matchLocaleTag("zh")).toBe("zh-CN");
      expect(matchLocaleTag("zh-Hans-CN")).toBe("zh-CN");
      expect(matchLocaleTag("zh-SG")).toBe("zh-CN");
    });

    it("does not map Traditional Chinese or unknown languages", () => {
      expect(matchLocaleTag("zh-TW")).toBeUndefined();
      expect(matchLocaleTag("zh-Hant-HK")).toBeUndefined();
      expect(matchLocaleTag("ja")).toBeUndefined();
      expect(matchLocaleTag("")).toBeUndefined();
      expect(matchLocaleTag(undefined)).toBeUndefined();
    });
  });

  describe("parseEnabledLocales", () => {
    it("always includes the default locale first and ignores unknown entries", () => {
      expect(parseEnabledLocales(undefined)).toEqual(["en"]);
      expect(parseEnabledLocales("")).toEqual(["en"]);
      expect(parseEnabledLocales("zh-CN")).toEqual(["en", "zh-CN"]);
      expect(parseEnabledLocales(" zh-CN , en ,fr, zh-CN")).toEqual([
        "en",
        "zh-CN",
      ]);
    });
  });

  describe("pickFromAcceptLanguage", () => {
    it("honours quality ordering and enabled locales", () => {
      expect(
        pickFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8", ["en", "zh-CN"]),
      ).toBe("zh-CN");
      expect(
        pickFromAcceptLanguage("en-US;q=0.5,zh-CN;q=0.9", ["en", "zh-CN"]),
      ).toBe("zh-CN");
      expect(pickFromAcceptLanguage("zh-CN,en;q=0.8", ["en"])).toBe("en");
      expect(pickFromAcceptLanguage("ja,ko;q=0.9", ["en", "zh-CN"])).toBe(
        undefined,
      );
      expect(pickFromAcceptLanguage("*", ["en", "zh-CN"])).toBeUndefined();
    });
  });

  describe("resolveLocale", () => {
    const enabledLocales = ["en", "zh-CN"] as const;

    it("prefers the account setting, then the cookie, then Accept-Language", () => {
      expect(
        resolveLocale({
          enabledLocales,
          userLocale: "zh-CN",
          cookieLocale: "en",
          acceptLanguage: "en",
        }),
      ).toBe("zh-CN");
      expect(
        resolveLocale({
          enabledLocales,
          cookieLocale: "zh-CN",
          acceptLanguage: "en",
        }),
      ).toBe("zh-CN");
      expect(
        resolveLocale({ enabledLocales, acceptLanguage: "zh-CN,en;q=0.8" }),
      ).toBe("zh-CN");
      expect(resolveLocale({ enabledLocales })).toBe("en");
    });

    it("ignores preferences the deployment does not enable", () => {
      expect(
        resolveLocale({
          enabledLocales: ["en"],
          userLocale: "zh-CN",
          cookieLocale: "zh-CN",
          acceptLanguage: "zh-CN",
        }),
      ).toBe("en");
    });

    it("ignores garbage values", () => {
      expect(
        resolveLocale({
          enabledLocales,
          userLocale: "xx",
          cookieLocale: "../etc",
        }),
      ).toBe("en");
    });
  });

  describe("locale cookie", () => {
    it("round-trips through a Cookie header", () => {
      const cookie = serializeLocaleCookie("zh-CN");
      expect(cookie).toMatch(/^NEXT_LOCALE=zh-CN; Path=\/;/);
      const header = `foo=bar; ${cookie.split(";")[0]}; baz=1`;
      expect(readLocaleCookie(header)).toBe("zh-CN");
    });

    it("returns undefined when absent", () => {
      expect(readLocaleCookie(undefined)).toBeUndefined();
      expect(readLocaleCookie("foo=bar")).toBeUndefined();
    });
  });
});
