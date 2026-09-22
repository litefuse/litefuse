import { env } from "@/src/env.mjs";

import { useTranslation } from "react-i18next";
export const CloudPrivacyNotice = ({ action }: { action: string }) => {
  const { t } = useTranslation();
  if (env.NEXT_PUBLIC_LITEFUSE_CLOUD_REGION === undefined) return null;
  return (
    <div className="text-muted-foreground mx-auto mt-10 max-w-lg text-center text-xs">
      {t("By {{action}} you are agreeing to our", { action })}{" "}
      <a
        href="https://litefuse.ai/terms"
        target="_blank"
        rel="noopener noreferrer"
        className="italic"
      >
        {t("Terms and Conditions")}
      </a>
      ,{" "}
      <a
        href="https://litefuse.ai/privacy"
        rel="noopener noreferrer"
        className="italic"
      >
        {t("Privacy Policy")}
      </a>
      {t(", and")}{" "}
      <a
        href="https://litefuse.ai/cookie-policy"
        rel="noopener noreferrer"
        className="italic"
      >
        {t("Cookie Policy")}
      </a>
      {t(". You also confirm that the entered data is accurate.")}
    </div>
  );
};
