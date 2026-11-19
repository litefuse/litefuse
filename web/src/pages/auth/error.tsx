import { ErrorPageWithSentry } from "@/src/components/error-page";
import { useRouter } from "next/router";

import { useTranslation } from "react-i18next";
export default function AuthError() {
  const { t } = useTranslation();
  const router = useRouter();
  const { error } = router.query;
  const errorMessage = error
    ? decodeURIComponent(String(error))
    : "An authentication error occurred. Please reach out to support.";

  return (
    <ErrorPageWithSentry
      title={t("Authentication Error")}
      message={errorMessage}
    />
  );
}
